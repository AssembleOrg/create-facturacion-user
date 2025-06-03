import { Injectable, Logger } from '@nestjs/common';
import puppeteer, { Browser, Page } from 'puppeteer';

@Injectable()
export class ScrapperService {
  private browser: Browser;
  private originalPage: Page;
  private url = 'https://www.afip.gob.ar/landing/default.asp';
  private logger = new Logger('ScrapperService');

  constructor() {
    // Constructor remains synchronous. Initialization is handled separately.
  }

  /**
   * Initializes the Puppeteer browser and opens a new page.
   */
  public async initialize(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: false,
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

    // Handle the new page that opens after clicking
    const newPage: Page = await this.getNewPage(this.browser);

    await this.loginToAfip(newPage, '27961588567', 'Arbolito5_Rafa1');
    await this.goToCertificadosDigitales(newPage);

    // this.page = await this.browser.newPage();
  }

  private close(): void {
    if (this.browser) {
      this.browser.close();
    }
  }

  private async getNewPage(browser: Browser): Promise<Page> {
    try {
      this.logger.log('Opening new page...');
      const newPagePromise: Promise<Page> = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timeout waiting for new page')),
          10_000, // Increased timeout for new page creation
        );

        browser.once('targetcreated', async (target) => {
          clearTimeout(timeout);
          const page = await target.page();
          if (!page || page === null) {
            reject(new Error('Page is null'));
          } else {
            resolve(page);
          }
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
      this.logger.error('Error in getNewPage:', error); // Log the full error details
      throw new Error('Failed to open new page: ' + error.message);
    }
  }

  private async goToCertificadosDigitales(page: Page): Promise<void> {
    try {
      this.logger.log('Navigating to Portal IVA...');
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
    }
  }

  private async loginToAfip(
    page: Page,
    username: string,
    password: string,
  ): Promise<void> {
    try {
      this.logger.log(`Logging in to AFIP...${username}`);
      // await page.waitForFunction(() => document.readyState === "complete");
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
      await page.click('#F1\\:btnIngresar');
    } catch (error) {
      console.error('Login failed, retrying...', error.message);
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
    }
  };
}
