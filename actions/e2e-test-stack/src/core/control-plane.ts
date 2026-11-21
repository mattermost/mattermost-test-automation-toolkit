// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
import { ActionError } from "./errors.ts";
import type { Invoke, InvokeInput } from "./lambda.ts";
import { errorText, handlerError, redact } from "./redact.ts";
import { isObject } from "./response.ts";
import type { StackResponse } from "./response.ts";

/** An ActionError's own message, already written for the reader; any other error's class and first line. */
export const reason = (e: unknown): string => (e instanceof ActionError ? e.message : errorText(e));

/** A create or control-plane reply as an object; undefined for anything else. */
export const parseResponse = (text: string): StackResponse | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** A control-plane reply: the response, or the handler's refusal, redacted. */
export type Reply = { response: StackResponse; refused?: undefined } | { refused: string; response?: undefined };

/** Invokes the control plane and reads its reply. A failed invoke, a non-200 or an unreadable reply is an ActionError. */
export async function callControlPlane(
  invoke: Invoke,
  target: Omit<InvokeInput, "Payload">,
  payload: Record<string, unknown>,
): Promise<Reply> {
  const named = `${target.FunctionName}:${target.Qualifier}`;
  let reply;
  try {
    reply = await invoke({ ...target, Payload: JSON.stringify(payload) });
  } catch (e) {
    throw new ActionError(`the invoke of ${named} failed: ${reason(e)}`);
  }
  const text = reply.Payload ? new TextDecoder().decode(reply.Payload) : "";
  if (reply.FunctionError) return { refused: handlerError(text) };
  if (reply.StatusCode !== 200) throw new ActionError(`the invoke answered ${reply.StatusCode}: ${handlerError(text)}`);
  const response = parseResponse(text);
  if (!response) throw new ActionError(`the control plane's reply is not a JSON object: ${redact(text).slice(0, 200)}`);
  return { response };
}
