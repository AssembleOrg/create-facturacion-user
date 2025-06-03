import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);

  app.enableCors({
    origin: '*', // o ['https://mi-app-frontend.com']
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 2) Configurar Swagger (OpenAPI)
  const config = new DocumentBuilder()
    .setTitle('Cert Microservice')
    .setDescription(
      'Microservicio para generación de claves RSA y CSRs dinámicos',
    )
    .setVersion('1.0')
    .addTag('cert')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap()
  .then(() => {})
  .catch((err) => {
    console.error(err);
  });
