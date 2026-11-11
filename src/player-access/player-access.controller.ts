import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AccountTypesGuard } from '../rbac/account-types.guard';
import { RequireAccountTypes } from '../rbac/account-types.decorator';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PlayerAccessService } from './player-access.service';
import { InvitePlayerDto, SetWhatsappDto } from './dto/player-access.dto';

/**
 * How an Agent brings a Player in and gets them back in: a WhatsApp number and
 * invite code the player app reads, and one-time sign-in links. Players redeem
 * those links with prediction-service (`POST /auth/enter`), not here — core
 * only ever *issues* them.
 */
@Controller('player-access')
@UseGuards(SessionAuthGuard, AccountTypesGuard)
export class PlayerAccessController {
  constructor(private readonly service: PlayerAccessService) {}

  @Get('me')
  @RequireAccountTypes('AGENT')
  me(@Req() req: AuthenticatedRequest) {
    return this.service.myInvite(req.user!);
  }

  @Put('me')
  @RequireAccountTypes('AGENT')
  setWhatsapp(@Body() dto: SetWhatsappDto, @Req() req: AuthenticatedRequest) {
    return this.service.setWhatsapp(req.user!, dto.whatsappNumber);
  }

  @Post('players')
  @RequireAccountTypes('AGENT')
  invite(@Body() dto: InvitePlayerDto, @Req() req: AuthenticatedRequest) {
    return this.service.invitePlayer(req.user!, dto);
  }

  @Post(':id/login-link')
  @HttpCode(200)
  @RequireAccountTypes('AGENT', 'AGENT_STAFF')
  reissue(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.service.reissueLink(req.user!, id);
  }
}
