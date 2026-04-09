import { Controller, Get, Delete, Param, Query, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import type { Response } from 'express';
import { OAuthService } from '../services/oauth.service';
import type { OAuthPurpose } from '../entities/oauth-token.entity';

const VALID_PURPOSES: OAuthPurpose[] = ['gmail', 'calendar'];
const MAX_ERROR_MSG_LENGTH = 200;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly frontendUrl: string;
  constructor(
    private readonly oauthService: OAuthService,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:5173',
    );
  }

  // Static routes must be declared before parameterized routes

  @Get('google/callback')
  @ApiOperation({ summary: 'Handle Google OAuth 2.0 callback' })
  @ApiResponse({ status: 302, description: 'Redirects to frontend on success' })
  async handleGoogleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const purpose = await this.oauthService.handleCallback(code, state);

      res.clearCookie('oauth_state');
      res.redirect(`${this.frontendUrl}/settings?auth=success&purpose=${purpose}`);
    } catch (error) {
      res.clearCookie('oauth_state');
      const safeMessage = this.sanitizeErrorMessage(error.message);
      res.redirect(
        `${this.frontendUrl}/settings?auth=error&message=${encodeURIComponent(safeMessage)}`,
      );
    }
  }

  @Get('google/status')
  @ApiOperation({ summary: 'Check Google OAuth authentication status for both accounts' })
  @ApiResponse({ status: 200, description: 'Authentication status for Gmail and Calendar' })
  async getAuthStatus(): Promise<{
    gmail: { authenticated: boolean; email?: string };
    calendar: { authenticated: boolean; email?: string };
  }> {
    return this.oauthService.getAuthStatus();
  }

  @Get('google/:purpose')
  @ApiOperation({ summary: 'Start Google OAuth 2.0 flow for a specific purpose' })
  @ApiParam({ name: 'purpose', enum: ['gmail', 'calendar'] })
  @ApiResponse({ status: 302, description: 'Redirects to Google login' })
  startGoogleAuth(
    @Param('purpose') purpose: string,
    @Res() res: Response,
  ): void {
    if (!this.isValidPurpose(purpose)) {
      res.status(400).json({ message: 'Invalid purpose. Use "gmail" or "calendar".' });
      return;
    }

    const { url, state } = this.oauthService.getAuthorizationUrl(purpose as OAuthPurpose);

    res.cookie('oauth_state', state, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
      path: '/api/auth',
    });

    res.redirect(url);
  }

  @Delete('google/:purpose')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect Google account for a specific purpose' })
  @ApiParam({ name: 'purpose', enum: ['gmail', 'calendar'] })
  @ApiResponse({ status: 204, description: 'Account disconnected' })
  async disconnect(@Param('purpose') purpose: string, @Res() res: Response): Promise<void> {
    if (!this.isValidPurpose(purpose)) {
      res.status(400).json({ message: 'Invalid purpose. Use "gmail" or "calendar".' });
      return;
    }

    await this.oauthService.disconnect(purpose as OAuthPurpose);
    res.status(HttpStatus.NO_CONTENT).send();
  }

  private isValidPurpose(purpose: string): purpose is OAuthPurpose {
    return VALID_PURPOSES.includes(purpose as OAuthPurpose);
  }

  private sanitizeErrorMessage(message: string): string {
    if (!message) return 'Authentication failed';
    return message
      .replace(/[\r\n]/g, ' ')
      .slice(0, MAX_ERROR_MSG_LENGTH);
  }
}
