# `/api/altas` — alta unificada

Copia endurecida de `src/scrapper`, en un módulo aparte. **`src/scrapper` no se
toca**: es el que está deployado y corriendo.

En una sola sesión de AFIP hace todo lo que antes eran tres pasadas:

```
login → CSR → certificado (computador fiscal) → Vault
      → relación WebServices > Facturación Electrónica
      → relación WebServices > Consulta y lectura de Comunicaciones (WSCCOMU / DFE)
      → punto de venta → Supabase (salePoint, ventanilla_adherida_at)
```

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/altas` | Encola el alta de un CUIT. Devuelve `{ jobId, enCola }`. |
| `GET` | `/api/altas/:id` | Estado detallado del job. |
| `GET` | `/api/altas?username=&status=&limit=` | Historial. |

Auth: `Authorization: Bearer <JWT de Supabase>` o, si `INTERNAL_API_KEY` está
seteada, el header `x-internal-key`.

Body:

```jsonc
{
  "username": "20123456789",
  // Si se mandan, se crea la fila de facturacion_users cuando falta.
  // password va EN CLARO: así la guarda esa tabla (clients.password sí va
  // encriptada con ENCRYPTION_KEY).
  "realName": "PEREZ JUAN",
  "password": "...",
  "opciones": {
    "certificado": true,
    "relacionFe": true,
    "relacionWsccomu": true,
    "puntoVenta": true,
    "reusarCert": true,
    "headless": false      // para mirar la corrida
  }
}
```

Las `opciones` sirven para reintentar sólo lo que faltó: por ejemplo, un CUIT
que quedó con certificado y sin punto de venta se arregla con
`{"certificado": false, "relacionFe": false, "relacionWsccomu": false}`.

## Cómo se lee el resultado

`GET /api/altas/:id` devuelve `stage` (última etapa completada), `errorCode`
(estable) y estos flags:

- `certEnVault` — key + cert guardados en `secret/data/certificate/<id>`.
- `certReusado` — el certificado ya estaba y se reusó.
- `relacionFeOk`, `relacionWsccomuOk` — relaciones de servicio generadas.
- `salePoint`, `salePointPreexistente`.
- **`parcial`** — hay certificado pero el alta no se completó. Es el caso que
  hay que mirar a mano: en AFIP quedó un computador fiscal sin el alta
  terminada.
- `shotsDir` — capturas de cada etapa, para auditar qué pasó.

Códigos de error (`AltaErrorCode`): `CLAVE_INCORRECTA`, `CAPTCHA`,
`USUARIO_BLOQUEADO`, `SIN_FACTURACION_USER`, `REPRESENTACION_REQUERIDA`,
`SERVICIO_NO_HABILITADO`, `CSR_FALLIDO`, `CERT_NO_CREADO`,
`CERT_NO_DESCARGADO`, `VAULT_FALLIDO`, `RELACION_FE_FALLIDA`,
`RELACION_WSCCOMU_FALLIDA`, `PUNTO_VENTA_FALLIDO`, `EMPRESA_NO_ENCONTRADA`,
`TIMEOUT`, `DESCONOCIDO`.

## Corrida masiva

El orquestador vive en el otro repo, porque el filtro de clientes y la clave
`ENCRYPTION_KEY` están ahí:

```bash
# terminal 1 — este servicio
pnpm start:dev

# terminal 2 — estudio-backend
pnpm crear:facturacion -- --muestra 10          # dry-run
pnpm crear:facturacion -- --muestra 20 --go     # corre de verdad
```

## Qué se arregló respecto de `src/scrapper`

| Problema | Antes | Ahora |
|---|---|---|
| Estado compartido | `currentAlias`, `currentSalePoint`, `browser` y `loggedIn` eran campos del servicio: dos jobs se pisaban, y `loggedIn` nunca volvía a `false` | Todo va en un `RunContext` por corrida, y los jobs corren en cola serial |
| Clave incorrecta | Clickeaba "Ingresar" y seteaba `loggedIn = true` sin mirar; el error salía 2 minutos después como timeout | El login espera portal-o-cartel y tira `CLAVE_INCORRECTA` / `USUARIO_BLOQUEADO` / `CAPTCHA` |
| Error 500 al crear el pem | El CSR había que generarlo antes con `POST /cert/generate`, que vaciaba `static/uploads` entero en cada llamada; si el dir no existía, `readdirSync` tiraba ENOENT | El CSR se genera en la misma corrida, en un directorio propio |
| Descarga del certificado | `setTimeout(() => {}, 15_000)` (que no espera nada) y después `readdirSync`: se leía un `.crdownload` o nada | Se espera archivo completo, tamaño estable y que sea un PEM |
| Computador equivocado | `select.selectedIndex = 1` a ciegas → el WS quedaba habilitado sobre otro certificado (`coe.notAuthorized` meses después) | Se exige el alias EXACTO de la corrida; si cae a substring, queda un warning |
| Empresa equivocada | `tokens.some(t => value.includes(t))`: un solo token en común alcanzaba | Puntuación por tokens, se exige ganador único, y el CUIT en el botón manda |
| Punto de venta mal creado | Número = `totalRecords + 1`; sistema fijo `MAW`; domicilio fijo `1-1`; el diálogo de advertencias era obligatorio | Número = max de la grilla + 1 con reintentos, domicilio del combo real, advertencias opcional, y el sistema **por condición del contribuyente** (ver abajo) |
| Sistema de facturación equivocado | — | En el combo de AFIP las opciones de **Exento en IVA** aparecen antes que las de Monotributo. Elegir "la primera que diga Web Services" le crea a un monotributista un punto de venta de exento: válido para AFIP, inservible para el cliente, y sin ningún aviso. Ahora la condición se deduce de los puntos de venta que el CUIT ya tiene y, si no se puede deducir sin ambigüedad, **el alta se corta** en vez de adivinar (se destraba con `opciones.sistemaPuntoVenta`) |
| "Aceptar" del formulario | Un único xpath sobre el texto del span | Varias estrategias + **reverificación** de que el punto de venta quedó creado |
| Certificado sin empresa | Se guardaba en Vault recién al final: si fallaba el punto de venta, se perdía la clave privada de un certificado que en AFIP ya existía | Se guarda apenas se descarga, y el job queda marcado `parcial` |
| Historial | sqlite `:memory:` | sqlite en disco, con etapa y código de error |
