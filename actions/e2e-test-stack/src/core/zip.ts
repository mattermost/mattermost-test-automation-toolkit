// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { readZipMember as readSharedZipMember, ZipError } from "../../../shared/src/zip.ts";
import { errorText } from "./redact.ts";

export { ZipError };

/**
 * Reads the member named exactly name from a ZIP archive's central directory, or returns undefined when there is none.
 * Reads stored and deflated members, at most max bytes uncompressed, and checks the CRC-32. ZIP64 and encrypted
 * archives are refused. Member names are only compared, never used as paths.
 */
export function readZipMember(zip: Buffer, name: string, max: number): Buffer | undefined {
  return readSharedZipMember(zip, name, max, errorText);
}
