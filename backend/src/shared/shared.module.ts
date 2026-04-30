import { Global, Module } from '@nestjs/common';
import { FileLoggerService } from './logger/file-logger.service';
import { CryptoService } from './crypto/crypto.service';
import { AppErrorEmitterService } from './errors/app-error-emitter.service';

@Global()
@Module({
  providers: [FileLoggerService, CryptoService, AppErrorEmitterService],
  exports: [FileLoggerService, CryptoService, AppErrorEmitterService],
})
export class SharedModule {}
