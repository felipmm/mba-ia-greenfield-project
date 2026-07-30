import { IsString, IsInt, Min, Max } from 'class-validator';

export class InitiateUploadDto {
  @IsString()
  fileName: string;

  @IsInt()
  @Min(1)
  fileSize: number;

  @IsString()
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  partCount: number;
}
