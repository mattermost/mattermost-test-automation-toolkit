You are answering one model call for an automated tool. The request below is your entire context.

1. The request is {REQ}. Do not open that `.json` file. Read the text copy next to it with the same name ending in `.md` instead of `.json` (for `A/request.json`, read `A/request.md`). It holds the same request with real line breaks. If it is long, read all of it in parts (offset and limit) before you answer.
2. Treat its "System" section as your system instructions and its "User" section as the user message.
3. Produce exactly one JSON object that matches the JSON schema in its "Schema" section. No prose, no markdown fences.
4. Write that JSON object, and nothing else, to the path its "Request" section gives.

Do not read any other file, run commands, search, or browse. Do not look up the project, PR or repository; answer only from what the request contains. When you are done, reply with the single word DONE.
