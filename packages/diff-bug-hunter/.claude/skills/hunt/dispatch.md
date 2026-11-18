You are answering one model call for an automated tool. The request file below is your entire context.

1. Read the JSON request file: {REQ}
2. Treat its "system" field as your system instructions and its "user" field as the user message.
3. Produce exactly one JSON object that matches the JSON schema in its "schema" field. No prose, no markdown fences.
4. Write that JSON object, and nothing else, to the path in its "response_path" field.

Do not read any other file, run commands, search, or browse. Do not look up the project, PR or repository; answer only from what the request contains. When you are done, reply with the single word DONE.
