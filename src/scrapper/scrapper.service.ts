import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import puppeteer, {
  Browser,
  Page,
  ElementHandle,
  TimeoutError,
} from 'puppeteer';
import { setTimeout } from 'timers';
import { SupabaseService } from 'src/supabase.service';
import { CertService } from 'src/cert/cert.service';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import Afip from '@afipsdk/afip.js';
import { config } from 'src/config/config';

@Injectable()
export class ScrapperService {
  private browser: Browser;
  private originalPage: Page;
  private url = 'https://www.afip.gob.ar/landing/default.asp';
  private logger = new Logger('ScrapperService');
  private currentAlias: string;
  private currentSalePoint: number;
  private loggedIn: boolean;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cerService: CertService,
  ) {
    // Constructor remains synchronous. Initialization is handled separately.
  }

  public async createCertificateAndPersistUser(usuario?: string): Promise<{
    cert: string;
    key: string;
    salesPoints: number[] | string[];
  }> {
    try {
      if (usuario) {
        const user = await this.supabaseService.getFacturacionUser(usuario);
        const downloadsDir = join(process.cwd(), 'static', 'downloads');
        const uploadsDir = join(process.cwd(), 'static', 'uploads');

        if (existsSync(downloadsDir)) {
          // Leer todo lo que haya dentro de downloadsDir
          rmSync(downloadsDir, { recursive: true, force: true });
          this.logger.log(`Se vació el contenido de: ${downloadsDir}`);
          mkdirSync(downloadsDir, { recursive: true });
        } else {
          // Si no existía, lo creamos
          mkdirSync(downloadsDir, { recursive: true });
          this.logger.log(`Creado directorio: ${downloadsDir}`);
        }
        await this.configAfipToBill(
          user.username!,
          user.password!,
          user.real_name!,
        );
        if (!this.currentAlias || !this.currentSalePoint) {
          throw new BadRequestException(
            ' Alias o punto de venta no encontrado',
          );
        }
        this.logger.verbose('GO TO UPDATEAT', user.username);
        await this.supabaseService.updateUpdatedAt(user.username!);
        this.logger.verbose('GO TO UPDATE', user.username);
        await this.supabaseService.updateFacturacionUser(user.username!, {
          salePoint: this.currentSalePoint,
        });

        const filesInDownloads = readdirSync(downloadsDir);
        const filesInUploads = readdirSync(uploadsDir);

        if (filesInDownloads.length === 0 || filesInUploads.length === 0) {
          throw new BadRequestException(
            ' No se encontraron archivos en downloads o uploads',
          );
        }

        const downloadFile = filesInDownloads[0];
        const uploadFile = filesInUploads.find((filename) =>
          filename.includes('key'),
        );

        if (!downloadFile || !uploadFile) {
          throw new BadRequestException(
            ' No se encontraron archivos en downloads o uploads',
          );
        }

        const downloadFilePath = join(downloadsDir, downloadFile);
        const uploadFilePath = join(uploadsDir, uploadFile);

        const downloadFileContent = readFileSync(downloadFilePath, 'utf-8');
        const uploadFileContent = readFileSync(uploadFilePath, 'utf-8');

        await this.cerService.loadUserCertificateAndKey(
          String(user.id),
          uploadFileContent,
          downloadFileContent,
        );

        const { cert, key } = await this.cerService.getUserCertificateAndKey(
          String(user.id),
        );

        const cuitOnlyNumber = user.username?.replace(/-/g, '');
        const afip = new Afip({
          CUIT: cuitOnlyNumber,
          cert,
          key,
          production: true,
          access_token: config.afipSdkToken,
        });
        const salesPoints: string[] | number[] =
          await afip.ElectronicBilling.getSalesPoints();

        if (!salesPoints || salesPoints.length === 0) {
          throw new BadRequestException('No se encontró punto de venta');
        }

        return {
          cert,
          key,
          salesPoints,
        };
      }

      throw new BadRequestException('No se encontró usuario');
    } catch (error) {
      this.logger.error('Error in initialize:', error);
      await this.close();
      throw new BadRequestException(error.message);
    }
  }

  private async configAfipToBill(
    usuario: string,
    password: string,
    realName: string,
  ): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--single-process',
        '--no-zygote',
      ],
    });

    this.originalPage = await this.browser.newPage();

    await this.originalPage.goto(this.url);
    await this.originalPage.waitForSelector(
      'a.btn.btn-sm.btn-info.btn-block.uppercase',
    );
    await this.originalPage.click('a.btn.btn-sm.btn-info.btn-block.uppercase');

    const newPage: Page = await this.getNewPage(this.browser);

    await this.loginToAfip(newPage, usuario, password);
    if (!this.loggedIn) {
      await this.close();
      throw new InternalServerErrorException(
        'No se pudo iniciar sesión en AFIP',
      );
    }
    // await new Promise((resolve) => setTimeout(resolve, 500_000));
    await this.goToCertificadosDigitales(newPage);

    const pageAlias = await this.getNewPage(this.browser);
    const today = new Date();
    const miliseconds = today.getTime();
    this.currentAlias = `new-csr-${miliseconds}`;
    await this.addAliasAndDownloadNewFile(
      pageAlias,
      this.currentAlias,
      usuario,
    );

    await newPage.bringToFront();

    await this.findService(
      'Administrador de Relaciones de Clave Fiscal',
      newPage,
    );

    await this.addServiceRelacion(usuario);

    await newPage.bringToFront();
    await this.findService(
      'Administración de Puntos de Venta y Domicilios',
      newPage,
    );

    await this.createSellPoint(realName);
    await this.close();
  }

  private async createSellPoint(nameOnDb: string): Promise<void> {
    try {
      const newPage: Page = await this.getNewPage(this.browser);

      // 1) Divide el nombre en tokens y normaliza a minúsculas
      const tokens = nameOnDb.split(/\s+/).map((t) => t.toUpperCase());

      // 2) Espera a que estén cargados todos los inputs de tipo botón
      await newPage.waitForSelector('td[align="center"] input[type="button"]');

      // 3) Obtén todos los botones y revisa su atributo `value`
      const buttons = await newPage.$$(
        'td[align="center"] input[type="button"]',
      );

      this.logger.verbose('LLEGUE HASTA BOTONES', buttons);

      let clicked = false;
      for (const btn of buttons) {
        // 4) Lee el atributo `value` de cada botón y pásalo a minúsculas
        const val = await (await btn.getProperty('value')).jsonValue();

        // 5) Comprueba si alguno de los tokens aparece en `val`
        if (tokens.some((token) => val.includes(token))) {
          // 6) Si coincide, haz click y sal del loop
          await btn.click();
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        throw new ConflictException(
          `Ningún botón encontró coincidencia para "${nameOnDb}"`,
        );
      }

      const btn_abm_pto_vta = '#btn_abm_pto_vta';
      await newPage.waitForSelector(btn_abm_pto_vta, {
        timeout: 16_000,
      });
      await newPage.click(btn_abm_pto_vta);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const dlgAdvertencias_btn_Cerrar = '#dlgAdvertencias_btn_Cerrar';
      await newPage.waitForSelector(dlgAdvertencias_btn_Cerrar, {
        timeout: 16_000,
        visible: true,
      });
      await newPage.click(dlgAdvertencias_btn_Cerrar);

      const buscado = 'Factura Electronica - Monotributo - Web Services';

      // Espera a que haya algún <td> en la página
      await newPage.waitForSelector('td');

      // Comprueba si alguno de los <td> tiene ese texto (ignorando espacios al inicio/final)
      const existeTd = await newPage.evaluate((buscado) => {
        const tds = Array.from(document.querySelectorAll('td'));
        return tds.some((td) => td.textContent?.trim() === buscado);
      }, buscado);

      this.logger.fatal(existeTd);

      if (!existeTd) {
        this.logger.verbose('Creando punto de venta');
        const tblmiGrilla_totalRecords = '#tblmiGrilla_totalRecords';
        await newPage.waitForSelector(tblmiGrilla_totalRecords, {
          timeout: 16_000,
        });
        const totalRecords = await newPage.evaluate(
          (tblmiGrilla_totalRecords) => {
            const totalRecords = document.querySelector(
              tblmiGrilla_totalRecords,
            )?.textContent;
            return totalRecords ? parseInt(totalRecords) : 0;
          },
          tblmiGrilla_totalRecords,
        );

        const [btn] = await newPage.$$(
          `xpath/ .//span[@class="ui-button-text" and normalize-space(text())="Agregar.."]`,
        );
        if (!btn) {
          throw new ConflictException('No se encontró el botón "Agregar.."');
        }

        // Haz click en el <span> encontrado
        await btn.click();

        await new Promise((resolve) => setTimeout(resolve, 3_000));

        const frmAlta_pveNro = '#frmAlta_pveNro';
        await newPage.waitForSelector(frmAlta_pveNro, {
          timeout: 16_000,
        });
        await newPage.type(frmAlta_pveNro, (totalRecords + 1).toString());

        this.currentSalePoint = totalRecords + 1;

        const frmAlta_sisCodigo = '#frmAlta_sisCodigo';
        await newPage.waitForSelector(frmAlta_sisCodigo, {
          timeout: 16_000,
        });
        await newPage.select(frmAlta_sisCodigo, 'MAW');

        const frmAlta_codTipoDomicilio = '#frmAlta_codTipoDomicilio';
        await newPage.waitForSelector(frmAlta_codTipoDomicilio, {
          timeout: 16_000,
        });
        await newPage.select(frmAlta_codTipoDomicilio, '1-1');

        const xpath = `xpath/ .//span[@class="ui-button-text" and normalize-space(text())="Aceptar"]`;

        // 3) Obtén el primer nodo y haz click
        const [spanAceptar] = await newPage.$$(xpath);
        if (!spanAceptar) {
          throw new ConflictException(
            'No se encontró ningún <span> con texto "Aceptar"',
          );
        }
        await spanAceptar.click();

        await new Promise((resolve) => setTimeout(resolve, 5_000));

        const JqueryInfoDialog_btnYes = '#JqueryInfoDialog_btnYes';
        await newPage.waitForSelector(JqueryInfoDialog_btnYes, {
          timeout: 16_000,
          visible: true,
        });
        await newPage.click(JqueryInfoDialog_btnYes);
      } else {
        this.logger.verbose('Punto de venta ya existe');
        await newPage.waitForSelector('#tblmiGrilla_dataTable');

        // Evaluate in the browser context
        const numero = await newPage.evaluate(() => {
          const rows = document.querySelectorAll('#tblmiGrilla_dataTable tr');

          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td')).map(
              (td) => td.textContent?.trim().replace(/\u00a0/g, ''), // remove &nbsp;
            );

            if (
              cells.some((text) =>
                text?.includes(
                  'Factura Electronica - Monotributo - Web Services',
                ),
              )
            ) {
              return cells[0]; // return the first <td> content (e.g. "2")
            }
          }

          return null; // not found
        });
        if (!numero)
          throw new ConflictException('No se encontró el punto de venta');
        this.currentSalePoint = Number(numero);
      }
    } catch (error) {
      this.logger.error('Error in createSellPoint:', error);
      throw new ConflictException('Error in createSellPoint');
    }
  }

  private async addServiceRelacion(cuit: string): Promise<void> {
    try {
      const newPage: Page = await this.getNewPage(this.browser);
      // await new Promise((resolve) => setTimeout(resolve, 300_000));
      const multipleDropdown = '#tblAutoridadAplicacion_cmbCont';
      try {
        await newPage.waitForSelector(multipleDropdown, { timeout: 16000 });
        await newPage.select(multipleDropdown, cuit);
        await newPage.waitForSelector('#cmdNuevaRelacion', {
          timeout: 16_000,
        });
        await newPage.click('#cmdNuevaRelacion');
      } catch (e) {
        this.logger.warn(
          'No se encontró el selector',
          e,
          'Running Single Alias',
        );
        await newPage.waitForSelector('#tblDetalleRelacion_lblRepresentado', {
          timeout: 16_000,
        });

        const text = await newPage.$eval(
          '#tblDetalleRelacion_lblRepresentado',
          (el) => el.textContent?.trim() || '',
        );

        this.logger.fatal(text);

        const usernameToCuit = `[${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}]`;

        if (!text.includes(usernameToCuit)) {
          throw new BadRequestException(
            'El usuario debe activar la representación hacía su persona juridica',
          );
        }

        await newPage.waitForSelector('#cmdNuevaRelacion', {
          timeout: 16_000,
        });
        await newPage.click('#cmdNuevaRelacion');
      }

      await new Promise((resolve) => setTimeout(resolve, 10_000));

      const cmdBuscarServicio = '#cmdBuscarServicio';
      await newPage.waitForSelector(cmdBuscarServicio, {
        timeout: 16_000,
      });
      await newPage.click(cmdBuscarServicio);

      await newPage.waitForSelector(
        'img[alt="Agencia de Recaudación y Control Aduanero"]',
        { visible: true },
      );
      await newPage.click(
        'img[alt="Agencia de Recaudación y Control Aduanero"]',
      );

      const [webServicesTd] = await newPage.$$(
        "xpath/.//td[text()='WebServices']",
      );
      if (!webServicesTd) {
        this.logger.error('No se encontró el <td> con texto "WebServices"');
        throw new ConflictException(
          'No se encontró el <td> con texto "WebServices"',
        );
      }

      await webServicesTd.click();

      const [feLink] = await newPage.$$(
        "xpath/.//a[text()='Facturación Electrónica']",
      );
      if (!feLink) {
        this.logger.error('No se encontró el enlace "Facturación Electrónica"');
        throw new ConflictException(
          'No se encontró el enlace "Facturación Electrónica"',
        );
      }

      this.logger.verbose('LLEGUE HASTA LINK', feLink);
      await feLink.click();

      const cmdBuscarUsuario = '#cmdBuscarUsuario';
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await newPage.waitForSelector(cmdBuscarUsuario, {
        timeout: 16_000,
        visible: true,
      });
      await newPage.click(cmdBuscarUsuario);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      console.log('LLEGUE HASTA CBO', this.currentAlias);

      // Selecciona la opción en índice 1 (segunda opción)
      await newPage.evaluate(() => {
        const select = document.querySelector(
          '#cboComputadoresAdministrados',
        ) as HTMLSelectElement;
        if (select && select.options.length > 1) {
          select.selectedIndex = 1;
          // Dispara manualmente el evento 'change' si la página lo escucha para recargar datos
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      this.logger.verbose('LLEGUE HASTA CMD');

      const cmdSeleccionarServicio = '#cmdSeleccionarServicio';
      await newPage.waitForSelector(cmdSeleccionarServicio, {
        timeout: 16_000,
        visible: true,
      });
      await newPage.click(cmdSeleccionarServicio);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const cmdGenerarRelacion = '#cmdGenerarRelacion';
      await newPage.waitForSelector(cmdGenerarRelacion, {
        timeout: 16_000,
        visible: true,
      });
      await newPage.click(cmdGenerarRelacion);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('Error in addServiceRelacion:', error);
      throw new ConflictException('Error in addServiceRelacion');
    }
  }

  private async findService(serviceName: string, page: Page): Promise<void> {
    try {
      this.logger.log(`Buscando servicio ${serviceName}...`);
      await page.waitForFunction(() => document.readyState === 'complete');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await page.waitForSelector('#buscadorInput', {
        timeout: 16_000,
      });
      await page.type('#buscadorInput', serviceName);
      await page.click('#rbt-menu-item-0');
    } catch (error) {
      console.error('Error in findService:', error);
      throw new ConflictException('Error in findService');
    }
  }

  private async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }

  private async addAliasAndDownloadNewFile(
    page: Page,
    alias: string,
    cuit: string,
  ): Promise<void> {
    try {
      this.logger.log('Adding alias to AFIP account...');
      // await new Promise((resolve) => setTimeout(resolve, 300_000));
      await page.waitForFunction(() => document.readyState === 'complete');
      const multipleDropdown = '#tblAutoridadAplicacion_cmbCont';

      try {
        await page.waitForSelector(multipleDropdown, { timeout: 16000 });
        await page.select(multipleDropdown, cuit);
        await page.waitForSelector('#cmdIngresar', {
          timeout: 20_000,
          visible: true,
        });
        await page.click('#cmdIngresar');
      } catch (e) {
        this.logger.warn(
          'No se encontró el selector',
          e,
          'Running Single Alias',
        );
        await page.waitForSelector('#tblDetalleRelacion_lblRepresentado', {
          timeout: 16_000,
        });

        const text = await page.$eval(
          '#tblDetalleRelacion_lblRepresentado',
          (el) => el.textContent?.trim() || '',
        );

        this.logger.fatal(text);

        const usernameToCuit = `[${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}]`;

        if (!text.includes(usernameToCuit)) {
          throw new BadRequestException(
            'El usuario debe activar la representación hacía su persona juridica',
          );
        }

        await page.waitForSelector('#cmdIngresar', {
          timeout: 20_000,
          visible: true,
        });
        await page.click('#cmdIngresar');
      }

      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await page.waitForSelector('#txtAliasCertificado', {
        timeout: 20_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await page.type('#txtAliasCertificado', alias);
      await page.waitForSelector('#archivo', {
        timeout: 20_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const idInput = '#archivo';
      await page.waitForSelector(idInput, { visible: true });
      const filePath = join(
        process.cwd(), // en runtime, process.cwd() = /usr/src/app
        'static',
        'uploads',
        'csr-creado.pem', // reemplaza con tu nombre real
      );

      const fileInputHandle = (await page.$(
        idInput,
      )) as ElementHandle<HTMLInputElement>;
      if (!fileInputHandle) {
        throw new ConflictException(
          `No se encontró el input con selector ${idInput}`,
        );
      }
      await fileInputHandle.uploadFile(filePath);
      await page.waitForSelector('#cmdIngresar', {
        timeout: 20_000,
        visible: true,
      });
      await page.click('#cmdIngresar');

      this.logger.error('Iniciando timeout');

      await new Promise((resolve) => setTimeout(resolve, 15_000)); // Espera 15 segundos

      this.logger.error('Terminando timeout');

      const downloadDir = join(
        process.cwd(), // en runtime, process.cwd() = /usr/src/app
        'static',
        'downloads',
      );
      const client = await page.createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });

      await page.waitForSelector('table', { visible: true });

      const matchingTrHandle = await page.evaluateHandle((alias) => {
        const tables = Array.from(
          document.querySelectorAll('table[align="center"]'),
        );
        for (const table of tables) {
          const rows = table.querySelectorAll('tr');
          for (const row of rows) {
            const td = row.querySelector('td');
            if (td && td.textContent?.trim() === alias) {
              return row;
            }
          }
        }
        return null;
      }, this.currentAlias);

      this.logger.log('matchingTrHandle', matchingTrHandle, this.currentAlias);

      if (!matchingTrHandle) {
        throw new ConflictException(
          `No se encontró una fila con el alias: ${this.currentAlias}`,
        );
      }

      const rowHandle = matchingTrHandle.asElement();
      if (!rowHandle)
        throw new ConflictException('El handle no es un elemento válido');

      // ✅ Obtener el <th> dentro de ese <tr>
      const thHandle = await rowHandle.$('th');
      if (!thHandle)
        throw new ConflictException('No se encontró el <th> dentro del <tr>');

      // ✅ Obtener el <a> dentro del <th>
      const aHandle = await thHandle.$('a');
      if (!aHandle)
        throw new ConflictException('No se encontró el <a> dentro del <th>');

      // ✅ Clickear el <a>
      await aHandle.click();
      setTimeout(
        () => {},
        15_000, // Awaiting for download to start
      );

      await page.waitForSelector('input[alt="Descargar"]', {
        timeout: 20_000,
        visible: true,
      });
      await page.click('input[alt="Descargar"]');
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      console.error('Error adding alias:', error);
      throw new ConflictException('Error adding alias');
    }
  }

  private async getNewPage(browser: Browser): Promise<Page> {
    try {
      this.logger.log('Opening new page...');
      const newPagePromise: Promise<Page> = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new ConflictException('Timeout waiting for new page')),
          10_000, // Increased timeout for new page creation
        );

        browser.once('targetcreated', (target) => {
          void (async () => {
            clearTimeout(timeout);
            const page = await target.page();
            if (!page) {
              reject(new ConflictException('Page is null'));
            } else {
              resolve(page);
            }
          })();
        });
      });

      this.logger.debug('Waiting for new page...');
      const newPageC: Page = await newPagePromise;
      this.logger.debug('New page created...');

      // if you know the page needs additional time to load fully, use a fixed delay
      await new Promise((resolve) => setTimeout(resolve, 4_000));

      this.logger.log('New page opened...');

      return newPageC;
    } catch (error) {
      this.logger.error('Error in getNewPage:', error);
      throw new ConflictException('Error in getNewPage');
    }
  }

  private async goToCertificadosDigitales(page: Page): Promise<void> {
    try {
      this.logger.log(
        'Navigating to Administración de Certificados Digitales...',
      );
      await page.waitForFunction(() => document.readyState === 'complete');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await page.waitForSelector('#buscadorInput', {
        timeout: 16_000,
      });
      await page.type(
        '#buscadorInput',
        'Administración de Certificados Digitales',
      );
      await page.click('#rbt-menu-item-0');
    } catch (error) {
      console.error('Error navigating to Portal IVA:', error);
      throw new ConflictException('Error navigating to Portal IVA');
    }
  }

  private async loginToAfip(
    page: Page,
    username: string,
    password: string,
  ): Promise<void> {
    try {
      this.logger.log(`Logging in to AFIP...${username}`);
      await page.waitForFunction(() => document.readyState === 'complete');
      this.logger.log('Waiting for username...');
      await page.waitForSelector('#F1\\:username', {
        timeout: 16_000,
      });
      await page.type('#F1\\:username', username);
      await page.click('#F1\\:btnSiguiente');

      await page.waitForSelector('#F1\\:password', {
        timeout: 16_000,
      });
      await page.type('#F1\\:password', password);
      this.logger.log('Clicking login button...');
      // await new Promise((resolve) => setTimeout(resolve, 2000_000));
      const idCaptcha = '#captcha img';
      try {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await page.waitForSelector(idCaptcha, { timeout: 10_000 });

        throw new ConflictException('Captcha activation');
      } catch (e) {
        if (e instanceof ConflictException) {
          this.logger.error(e.message);
          throw new ConflictException('Captcha activation');
        }
        if (e instanceof TimeoutError) {
          this.logger.warn('No se encontró el captcha (timeout)');
        } else {
          this.logger.warn('Error esperando el captcha', e);
        }
      }
      await page.click('#F1\\:btnIngresar');
      this.loggedIn = true;
    } catch (error) {
      if (error.message.includes('Captcha activation')) {
        this.logger.error('Captcha activation, retrying...', error.message);
        throw new ConflictException('Captcha activation');
      }
      this.logger.error('Login failed, retrying...', error.message);
      await this.retryWithDelay(page, '#F1\\:password', 6_000);
    }
  }

  private retryWithDelay = async (
    page: Page,
    selector: string,
    delay: number,
  ) => {
    try {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await page.waitForFunction(() => document.readyState === 'complete');
      await page.waitForSelector(selector, {
        timeout: 16_000,
      });
    } catch (error: unknown) {
      console.error('Retry failed, retrying...', error);
      throw new ConflictException('Retry failed');
    }
  };
}
