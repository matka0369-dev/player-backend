import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

// Dev: any localhost/127.0.0.1 port may call the API (frontends move ports
// constantly during development). Prod: only origins explicitly listed in
// CORS_ALLOWED_ORIGINS. Credentials are on because auth is a session cookie,
// which means the origin must be reflected exactly — "*" is not permitted
// by browsers alongside credentials.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function buildCorsOrigin() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowlist = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // No Origin header: same-origin navigations, curl, server-to-server.
    if (!origin) return callback(null, true);
    if (!isProd && LOCALHOST_ORIGIN.test(origin)) return callback(null, true);
    if (allowlist.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: buildCorsOrigin(), credentials: true });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
