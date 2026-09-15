import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { AppModule } from './app.module';

// Dev: any localhost/127.0.0.1 port may call the API (frontends move ports
// constantly during development). Prod: reflect credentials-enabled CORS
// headers only for origins explicitly listed in CORS_ALLOWED_ORIGINS.
//
// An unlisted origin is NOT hard-rejected — the request is served with no
// CORS headers. The four portals call this API same-origin through Vercel
// rewrites (/api/core/*), and Vercel forwards the browser's Origin header;
// the browser does no CORS enforcement on a same-origin response, so the
// absent headers are harmless there. A genuinely cross-origin caller still
// gets no Access-Control-Allow-Origin / -Credentials and is blocked by the
// browser exactly as before. "*" is never permitted alongside credentials.
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
    // Unlisted origin: serve the request, add no CORS headers.
    return callback(null, false);
  };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: buildCorsOrigin(), credentials: true });
  // Express's default JSON body limit (100kb) is well under a base64-encoded
  // 2MB image request — see MAX_IMAGE_BYTES in requests/image-data-url.util.
  // 6mb covers that with room for the rest of the JSON envelope.
  app.use(json({ limit: '6mb' }));
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
