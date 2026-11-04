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
  const os = osOfReport(name);
  if (os != null) return os;
  if (/(^|[^a-z])ios([^a-z]|$)/i.test(name)) return "ios";
  if (/android/i.test(name)) return "android";
  return null;
};

// Files whose change reaches one platform only, so a change to them can break that platform alone.
const PLATFORM_FILES: Record<string, RegExp> = {
  ios: /(^|\/)ios\/|(^|\/)Podfile(\.lock)?$|\.(swift|m|mm|h|pbxproj|xcconfig|entitlements|plist|storyboard|xib)$|\.xc(odeproj|workspace)\//i,
  android: /(^|\/)android\/|\.(gradle|kts|kt|java)$|(^|\/)gradle\.properties$|AndroidManifest\.xml$/i,
  linux: /(^|[/_.-])(linux|ubuntu|debian|deb|rpm|snap|flatpak|appimage)([/_.-]|$)/i,
  windows: /(^|[/_.-])(win|win32|win64|windows|msi|msix|appx|nsis)([/_.-]|$)|\.(ps1|bat|cmd)$/i,
  macos: /(^|[/_.-])(mac|macos|darwin|osx|dmg|mas)([/_.-]|$)|\.(entitlements|plist)$/i,
};

export const onlyOnPlatform = (platform: string, file: string): boolean => Boolean(PLATFORM_FILES[platform]?.test(file));

// A file only other platforms build, so a change to it cannot reach this one.
const onlyElsewhere = (platform: string, file: string): boolean =>
  !onlyOnPlatform(platform, file) && Object.keys(PLATFORM_FILES).some((p) => p !== platform && onlyOnPlatform(p, file));

/**
 * Why the same commit shows the PR is not a blocking borderline failure's cause, or null. It must have passed on another
 * platform of this commit and failed on none, and have passed here earlier on this PR (this_pr) with nothing the PR
 * changed since able to reach the failing platform: none, or only files other platforms build. Then the same code passed
 * and failed on this platform, which is a flake. A pass on the other platforms alone is no such evidence: shared code can
 * branch on the platform, so a PR can break one platform without touching a file named for it. For the same reason a
 * shared file the PR changed since the pass, even one the error does not name, is not ruled out here: that failure goes
 * to the judge, which reads those changes.
 */
export function commonSenseClear(f: Finding, pack: Pack | null | undefined): string | null {
  if (!pack || !f.blocking || !BORDERLINE.has(f.class) || f.identity_unresolved || f.out_of_date || f.decision === "evidence_incomplete") return null;
  const platform = platformOf(f.report_name);
  const lanes = f.other_lanes ?? [];
  const passedOn = lanes.filter((l) => l.result === "passed").map((l) => l.platform);
  if (!platform || !PLATFORM_FILES[platform] || !passedOn.length || lanes.some((l) => FAILED_STATUSES.has(l.result) || l.result === "flaky")) return null;
  const elsewhere = `passed on ${passedOn.join(" and ")} on this same commit`;
  const since = f.since_last_pass;
  // The PR's changes in place at the earlier pass ran on this platform then; only what it changed since can be new here.
  // Where the PR's own changes are unknown, every change since the pass counts.
  if (since && evidenceIds(pack).includes("this_pr") && (since.pr_changed ?? since.files).every((x) => onlyElsewhere(platform, x))) {
    const at = f.this_pr.last_pass?.commit_sha?.slice(0, 7);
    return `Failed only on ${platform}: it ${elsewhere}, and passed on ${platform} earlier on this PR${at ? ` (${at})` : ""} with nothing related this PR changed since.`;
  }
  return null;
}
