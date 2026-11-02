# Integrate Feedback Loop into an application

1. Read the application's agent instructions.
2. Install `git-feedback-loop`.
3. Read `docs/integration.md` from the installed package.
4. Add authenticated submission and receipt routes.
5. Store immutable submissions with an owner ID and a unique feedback ID.
6. Add a transactional delivery claim before GitHub network calls.
7. Schedule pending delivery retries.
8. Add the React widget or reuse the browser helpers in the existing interface.
9. Keep GitHub tokens and issue URLs on the server.
10. Test submission retries, owner checks, and uncertain GitHub responses.
11. Run the application's required checks.

Enable screenshots and voice only when their server adapters are available.
Preserve the application's privacy rules and provider configuration.
Use the agent loop protocol for an external worker.
Keep source, test, merge, deployment, and live verification evidence separate.
