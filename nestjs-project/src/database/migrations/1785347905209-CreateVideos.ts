import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateVideos1785347905209 implements MigrationInterface {
    name = 'CreateVideos1785347905209'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'uploading', 'processing', 'ready', 'error')`);
        await queryRunner.query(`CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "url_hash" character varying(21) NOT NULL, "title" character varying(255) NOT NULL DEFAULT '', "description" text, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "error_message" text, "duration_seconds" double precision, "file_size_bytes" bigint, "width" integer, "height" integer, "codec" character varying(50), "bitrate_bps" integer, "storage_bucket" character varying(100) NOT NULL, "storage_key" character varying(500) NOT NULL, "thumbnail_storage_key" character varying(500), "channel_id" uuid NOT NULL, "upload_id" character varying(255), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_15a3baef9bd761db5a850ea74e8" UNIQUE ("url_hash"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_15a3baef9bd761db5a850ea74e" ON "videos" ("url_hash") `);
        await queryRunner.query(`ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_15a3baef9bd761db5a850ea74e"`);
        await queryRunner.query(`DROP TABLE "videos"`);
        await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
    }

}
