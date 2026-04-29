import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { LoggingInterceptor } from './shared/interceptors/logging.interceptor';
import { FileLoggerService } from './shared/logger/file-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  const logger = app.get(FileLoggerService);
  app.useLogger(logger);

  // Serve frontend static files when running in Electron (for OAuth redirects)
  const frontendDistPath = process.env.FRONTEND_DIST_PATH;
  if (frontendDistPath) {
    const resolvedPath = path.resolve(frontendDistPath);
    const indexHtml = path.join(resolvedPath, 'index.html');
    const exists = fs.existsSync(indexHtml);
    logger.log(`Frontend static serving: FRONTEND_DIST_PATH=${frontendDistPath}`, 'Bootstrap');
    logger.log(`Frontend resolved path: ${resolvedPath}`, 'Bootstrap');
    logger.log(`Frontend index.html exists: ${exists}`, 'Bootstrap');
    if (exists) {
      app.use(express.static(resolvedPath));
      // SPA fallback: serve index.html for non-API routes
      app.use((req, res, next) => {
        if (!req.path.startsWith('/api')) {
          res.sendFile(indexHtml);
        } else {
          next();
        }
      });
      logger.log('Frontend static middleware registered', 'Bootstrap');
    } else {
      logger.warn(`Frontend index.html NOT FOUND at ${indexHtml} — OAuth redirects will fail`, 'Bootstrap');
    }
  } else {
    logger.log('FRONTEND_DIST_PATH not set — skipping static file serving', 'Bootstrap');
  }

  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ limit: '1mb', extended: true }));

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(
    new AllExceptionsFilter(false),
  );

  app.useGlobalInterceptors(new LoggingInterceptor());

  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
  app.enableCors({
    origin: frontendUrl === '*' ? false : frontendUrl,
    credentials: true,
  });

  app.enableShutdownHooks();

  {
    const config = new DocumentBuilder()
      .setTitle('ParentSync API')
      .setDescription('ParentSync backend API')
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT ?? 41932;
  await app.listen(port);
}
bootstrap();
