// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import { FAILED_STATUSES } from "../../shared/src/tsio.ts";
import { BORDERLINE } from "./classify.ts";
import { osOfReport } from "./config.ts";
import { evidenceIds } from "./pack.ts";
import type { Finding, Pack } from "./types.ts";

/** The platform a report ran on: a desktop OS by its report name, or a mobile one (detox-ios). Null for a worker of one lane. */
export const platformOf = (report: string | null | undefined): string | null => {
  const name = String(report ?? "");
  return osOfReport(name) ?? (/(^|[^a-z])ios([^a-z]|$)/i.test(name) ? "ios" : /android/i.test(name) ? "android" : null);
};

// Files whose change reaches one platform only, so a change to them can break that platform alone.
const PLATFORM_FILES: Record<string, RegExp> = {
  ios: /(^|\/)ios\/|(^|\/)Podfile(\.lock)?$|\.(swift|m|mm|h|pbxproj|xcconfig|entitlements|plist|storyboard|xib)$|\.xc(odeproj|workspace)\//i,
  android: /(^|\/)android\/|\.(gradle|kts|kt|java)$|(^|\/)gradle\.properties$|AndroidManifest\.xml$/i,
  linux: /(^|[/_.-])(linux|ubuntu|debian|deb|rpm|snap|flatpak|appimage)([/_.-]|$)/i,
  windows: /(^|[/_.-])(win|win32|win64|windows|msi|msix|appx|nsis)([/_.-]|$)|\.(ps1|bat|cmd)$/i,
  macos: /(^|[/_.-])(mac|macos|darwin|osx|dmg|mas)([/_.-]|$)|\.(entitlements|plist)$/i,
};

/** Whether a changed file reaches the given platform only (see PLATFORM_FILES). */
export const onlyOnPlatform = (platform: string, file: string): boolean => Boolean(PLATFORM_FILES[platform]?.test(file));

/**
 * A failure common sense clears without the model, because the same commit shows the PR is not its cause:
 * - the same test passed on another platform of this same commit, and failed on none, and
 * - no change it rests on reaches the failing platform alone, and
 * - either this PR passed the test here earlier and nothing related that the PR itself changed since (this_pr), or the
 *   test is stable on trunk (REGRESSION) and the PR changes nothing it uses: not the spec, no file its error names.
 * A PR that breaks the shared code fails every platform, so a pass on one is what rules the PR out. Returns why, or null.
 * Only a blocking borderline failure with complete evidence (it has a pack) is considered.
 */
export function commonSenseClear(f: Finding, pack: Pack | null | undefined, prFiles: string[]): string | null {
  if (!pack || !f.blocking || !BORDERLINE.has(f.class) || f.identity_unresolved || f.out_of_date || f.decision === "evidence_incomplete") return null;
  const platform = platformOf(f.report_name);
  const lanes = f.other_lanes ?? [];
  const passedOn = lanes.filter((l) => l.result === "passed").map((l) => l.platform);
  if (!platform || !PLATFORM_FILES[platform] || !passedOn.length || lanes.some((l) => FAILED_STATUSES.has(l.result))) return null;
  const elsewhere = `passed on ${passedOn.join(" and ")} on this same commit`;
  const since = f.since_last_pass;
  // The PR's changes in place at the earlier pass ran on this platform then; only what it changed since can be new here.
  if (since && evidenceIds(pack).includes("this_pr") && !(since.pr_changed ?? since.files).some((x) => onlyOnPlatform(platform, x))) {
    const at = f.this_pr.last_pass?.commit_sha?.slice(0, 7);
    return `Failed only on ${platform}: it ${elsewhere}, and passed on ${platform} earlier on this PR${at ? ` (${at})` : ""} with nothing related this PR changed since.`;
  }
  if (f.class === "REGRESSION" && f.untouched === true && !pack.diff_hunks_of_files_named_in_error.length && !pack.pr.spec_file_changed_by_pr && !prFiles.some((x) => onlyOnPlatform(platform, x)))
    return `Failed only on ${platform}: it ${elsewhere}, passes on trunk (${f.trunk.passes} of ${f.trunk.runs} runs), and this PR changes nothing it uses.`;
  return null;
}
