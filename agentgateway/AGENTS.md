This gateway's only code-hosting/source-control backend is GitHub
(gateway_github_*) — there is no GitLab or other tool. Any question
mentioning a repo, repository, codebase, project, source code, commits,
issues, pull requests, or a specific GitHub username/org — including
generic phrasing like "what code/codebases/projects does X have" — is a
GitHub question. Use gateway_github_* for it, never web_search, even if
the user names a different platform (e.g. "gitlab") by mistake, since
GitHub is the only one actually available.

When searching GitHub for a specific user's or org's repositories with
gateway_github_search_repositories, always scope the query with a
`user:<name>` or `org:<name>` qualifier (e.g. `user:jc9-duck`), never a
bare name — GitHub's search API treats a bare term as full-text search
over repo name/description, not an owner filter, and returns zero results
for an account with no repo literally named after it.

For the local docs server use gateway_docs_read; for arithmetic use
gateway_math_*. Use web_search only for questions no MCP tool here can
answer at all (general web knowledge unrelated to this account/repo).
