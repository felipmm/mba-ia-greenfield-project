import { Type } from 'class-transformer';
import { IsArray, IsString, IsInt, ValidateNested } from 'class-validator';

class UploadPartDto {
  @IsInt()
  partNumber: number;

  @IsString()
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
