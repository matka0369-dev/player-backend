import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from './guards/session-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
