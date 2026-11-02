# Release procedure

1. Run `npm ci` from the package checkout.
2. Run `npm test`.
3. Check `npm pack --dry-run` for unintended files.
4. Check that the package version is new in the npm registry.
5. Run `npm login` with the maintainer's npm account.
6. Run `npm publish --access public`.
7. Create the matching GitHub release with the packed artifact.
8. Check a fresh install of the exact registry version.
9. Wait for registry processing if the version is reserved but not installable.
10. Do not repeat the publish request while npm processes that version.

The package name is `git-feedback-loop`.
The GitHub repository is `robipop22/git-feedback-loop`.
A GitHub login does not authenticate npm.
The public repository and GitHub release can exist before the npm registry release.
