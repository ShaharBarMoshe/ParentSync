import { Global, Module } from '@nestjs/common';
import { FileLoggerService } from './logger/file-logger.service';
import { CryptoService } from './crypto/crypto.service';

@Global()
@Module({
  providers: [FileLoggerService, CryptoService],
  exports: [FileLoggerService, CryptoService],
})
export class SharedModule {}
