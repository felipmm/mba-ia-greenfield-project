import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Worker runs until process is terminated
  process.on('SIGTERM', () => {
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

bootstrap().catch((err: Error) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
