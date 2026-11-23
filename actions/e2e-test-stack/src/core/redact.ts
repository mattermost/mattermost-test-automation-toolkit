// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/**
 * Takes ARNs and account ids out of text that reaches the log, the outputs or the summary. The placeholders are not
 * HTML tags, which the summary's Markdown would drop; a 12-digit run inside a hyphenated name, such as a batch id, is
 * kept.
 */
export const redact = (text: string): string => redactArns(text).replace(/(?<![\w-])\d{12}(?![\w-])/g, "[account]");

/** Takes ARNs alone out of text, leaving other 12-digit numbers as they are, as a server's log may hold them. */
export const redactArns = (text: string): string =>
  text.replace(/arn:aws[a-z-]*:(?:[^\s"';()|`<>[\]{}]*[^\s"',;()|`<>[\]{}.])?/g, "[arn]");

/** A thrown value's name and the first line of its message, cut to 200 characters, with ARNs and account ids out. */
export const errorText = (e: unknown): string => {
  const name = (e as { name?: string })?.name || "Error";
  const message = redact(String((e as { message?: string })?.message ?? e))
    .split("\n")[0]
    .slice(0, 200);
  return `${name}: ${message}`;
};

/** The Lambda runtime's handler-error payload, {"errorMessage": ...}, or the raw text, redacted. */
export const handlerError = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as { errorMessage?: unknown };
    if (typeof parsed?.errorMessage === "string") return redact(parsed.errorMessage);
  } catch {
    // Not JSON: the text itself is the message.
  }
  return redact(text.trim()).slice(0, 500) || "no reason given";
};
