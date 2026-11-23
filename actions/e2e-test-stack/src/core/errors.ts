// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/** A failure an action raises on purpose, with a message for the person reading the run; it is reported without a stack. */
export class ActionError extends Error {}
ActionError.prototype.name = "ActionError";
