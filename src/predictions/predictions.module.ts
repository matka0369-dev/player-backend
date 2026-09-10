import { Module } from '@nestjs/common';
import { PredictionsController } from './predictions.controller';
import { PredictionsService } from './predictions.service';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [PredictionsController],
  providers: [PredictionsService],
})
export class PredictionsModule {}
