import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSettingEntity } from './entities/user-setting.entity';
import { ChildEntity } from './entities/child.entity';
import { TypeOrmSettingsRepository } from './repositories/typeorm-settings.repository';
import { TypeOrmChildRepository } from './repositories/typeorm-child.repository';
import {
  SETTINGS_REPOSITORY,
  CHILD_REPOSITORY,
} from '../shared/constants/injection-tokens';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { ChildService } from './child.service';
import { ChildController } from './child.controller';

@Module({
  imports: [TypeOrmModule.forFeature([UserSettingEntity, ChildEntity])],
  controllers: [SettingsController, ChildController],
  providers: [
    SettingsService,
    ChildService,
    {
      provide: SETTINGS_REPOSITORY,
      useClass: TypeOrmSettingsRepository,
    },
    {
      provide: CHILD_REPOSITORY,
      useClass: TypeOrmChildRepository,
    },
  ],
  exports: [SETTINGS_REPOSITORY, CHILD_REPOSITORY, SettingsService, ChildService],
})
export class SettingsModule {}
