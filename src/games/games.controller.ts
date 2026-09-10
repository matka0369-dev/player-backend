import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AccountTypesGuard } from '../rbac/account-types.guard';
import { RequireAccountTypes } from '../rbac/account-types.decorator';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { GamesService } from './games.service';
import { ResultsService } from './results.service';
import { CreateGameDto } from './dto/create-game.dto';
import { UpdateGameDto } from './dto/update-game.dto';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { SetEnablementDto } from './dto/set-enablement.dto';
import { SubmitResultDto } from './dto/submit-result.dto';
import { CorrectResultDto } from './dto/correct-result.dto';

@Controller('games')
@UseGuards(SessionAuthGuard)
export class GamesController {
  constructor(
    private readonly gamesService: GamesService,
    private readonly resultsService: ResultsService,
  ) {}

  @Get()
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN', 'ADMIN', 'ADMIN_STAFF')
  list(@Req() req: AuthenticatedRequest) {
    return this.gamesService.list(req.user!);
  }

  @Post()
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  create(@Body() dto: CreateGameDto, @Req() req: AuthenticatedRequest) {
    return this.gamesService.create(dto, req.user!);
  }

  @Patch(':id')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateGameDto) {
    return this.gamesService.update(id, dto);
  }

  @Post(':id/holidays')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  addHoliday(@Param('id') id: string, @Body() dto: CreateHolidayDto) {
    return this.gamesService.addHoliday(id, dto);
  }

  @Delete(':id/holidays/:date')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  removeHoliday(@Param('id') id: string, @Param('date') date: string) {
    return this.gamesService.removeHoliday(id, date);
  }

  // Entering a result is what pays people, so it sits at the same tier that
  // defines the games: Platform Admin only. Settlement runs inside the same
  // request — see ResultsService.submitResult.
  @Post(':id/result')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  submitResult(@Param('id') id: string, @Body() dto: SubmitResultDto) {
    return this.resultsService.submitResult(id, dto);
  }

  // Replacing a result that was already paid out. Its own route rather than a
  // flag on the one above: this un-pays winners and can leave a Player
  // negative, and that should never be reachable by omitting a field. Same
  // tier — whoever can publish a result is who corrects one — and the caller
  // is recorded on the audit row.
  @Post(':id/result/correct')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  correctResult(
    @Param('id') id: string,
    @Body() dto: CorrectResultDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.resultsService.correctResult(id, dto, req.user!);
  }

  // The correction history for a game — what was changed, by whom, and how
  // much moved. Read-only; the corrected round itself looks as if the right
  // numbers were entered first time, so this is the only place the change
  // remains visible.
  @Get(':id/corrections')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('PLATFORM_ADMIN')
  corrections(@Param('id') id: string) {
    return this.resultsService.correctionsForGame(id);
  }

  // Admin's own on/off switch for its whole subtree — see
  // GamesService.setEnablement for the intrinsic-vs-delegated split.
  @Patch(':id/enablement')
  @UseGuards(AccountTypesGuard)
  @RequireAccountTypes('ADMIN', 'ADMIN_STAFF')
  setEnablement(@Param('id') id: string, @Body() dto: SetEnablementDto, @Req() req: AuthenticatedRequest) {
    return this.gamesService.setEnablement(id, dto, req.user!);
  }
}
