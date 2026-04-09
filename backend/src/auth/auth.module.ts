import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OAuthTokenEntity } from './entities/oauth-token.entity';
import { OAuthService } from './services/oauth.service';
import { AuthController } from './controllers/auth.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [TypeOrmModule.forFeature([OAuthTokenEntity]), SettingsModule],
  controllers: [AuthController],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class AuthModule {}
