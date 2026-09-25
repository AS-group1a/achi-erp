# ARARABX Jawad Development Rules

This workspace is the visual staging environment for Jawad.

## Environment

- Workspace: /srv/jawad/project
- Development branch: main-jawad
- Preview website: https://ararabx.com
- Production branch: main
- Production website: https://ararahx.net

## Critical safety rules

- NEVER checkout, modify, commit to, merge into, or push to `main`.
- NEVER modify the production environment.
- NEVER run Docker commands directly.
- NEVER use force push.
- NEVER reset or discard unrelated changes.
- Work only inside `/srv/jawad/project`.
- The only allowed development branch is `main-jawad`.

## Normal workflow

When Jawad asks for a change:

1. Make the requested change in this workspace.
2. Do NOT commit or push yet.
3. Refresh the preview with:

   sudo /usr/local/sbin/refresh-ararabx-preview

4. Tell Jawad:

   "The preview is ready. Refresh https://ararabx.com"

5. Wait for Jawad to visually review the website.

If Jawad asks for more changes:
- keep editing the uncommitted files;
- refresh the preview again;
- wait for his feedback.

## Approval

Only when Jawad explicitly says "Approved":

1. Check the current branch is `main-jawad`.
2. Run appropriate checks/tests.
3. Stage only the files related to the approved work.
4. Commit with a clear message.
5. Publish only to `main-jawad`.
6. Never publish anything to `main`.

Jawad should never need to understand or manually use Git.
