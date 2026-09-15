import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { RbacModule } from './rbac/rbac.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { RatesModule } from './rates/rates.module';
import { LedgerModule } from './ledger/ledger.module';
import { GamesModule } from './games/games.module';
import { PredictionsModule } from './predictions/predictions.module';
import { RequestsModule } from './requests/requests.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    RbacModule,
    UsersModule,
    RolesModule,
    RatesModule,
    LedgerModule,
    GamesModule,
    PredictionsModule,
    RequestsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
