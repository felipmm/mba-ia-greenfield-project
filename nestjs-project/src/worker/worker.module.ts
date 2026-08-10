import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { VideoProcessor } from './video.processor';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { VideosModule } from '../videos/videos.module';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import mailConfig from '../config/mail.config';
import swaggerConfig from '../config/swagger.config';
import { envValidationSchema } from '../config/env.validation';
import { VIDEO_PROCESS_QUEUE } from '../queue/queue.types';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        swaggerConfig,
        storageConfig,
        queueConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESS_QUEUE }),
    StorageModule,
    UsersModule,
    VideosModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
