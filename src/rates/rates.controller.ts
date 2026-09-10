import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { RatesService } from './rates.service';
import { UpdateRatesDto } from './dto/update-rates.dto';
import { BET_TYPES, BET_TYPE_LABEL, PROFIT_SHARE_TOTAL } from './rates.constants';

@Controller('rates')
@UseGuards(SessionAuthGuard)
export class RatesController {
  constructor(private readonly ratesService: RatesService) {}

  // Static metadata every portal needs to render a card without hardcoding
  // the bet taxonomy in four frontends.
  @Get('meta')
  meta() {
    return {
      betTypes: BET_TYPES.map((betType) => ({ betType, label: BET_TYPE_LABEL[betType] })),
      profitShareTotal: PROFIT_SHARE_TOTAL,
    };
  }

  @Get('me')
  myCards(@Req() req: AuthenticatedRequest) {
    return this.ratesService.myCards(req.user!);
  }

  @Patch('me/default')
  updateDefault(@Body() dto: UpdateRatesDto, @Req() req: AuthenticatedRequest) {
    return this.ratesService.updateDefaultCard(dto.entries, req.user!);
  }

  @Patch('me/giving')
  updateGiving(@Body() dto: UpdateRatesDto, @Req() req: AuthenticatedRequest) {
    return this.ratesService.updateGivingCard(dto.entries, req.user!);
  }

  // Admin-side read-only inspection of one of its own Agents.
  @Get('agent/:id')
  agentCards(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.ratesService.agentCards(id, req.user!);
  }
}
