# Agent notes

Clear Chat is a Paseo plugin that renders agent conversations. These notes are for coding agents and contributors.

## Language

Issues, pull requests, commit messages, and code comments are written in English.

## Branches

`pre` is the test branch. Automated and agent work is merged into `pre` only. `main` is the release branch. Merging into `main`, tagging, and publishing a release happen only on an explicit instruction from the maintainer, never automatically.

## Workflow

One small task per branch (`ib/<card>`). Open a pull request to `pre`. A model from a different vendor than the one that wrote the code reviews the change. Tests must pass before merge.

Before a pull request, run:

```
npm ci
npm test
npx tsc --noEmit
```

## Scope

Do not edit `README*`, `CHANGELOG`, locales (`client/locales/*.json`), `OVERVIEW*`, or the version as part of unrelated work. Approved user-facing text and translations change only through their own reviewed task.

## Privacy

Commit identity is `jasonhnd <3293256+jasonhnd@users.noreply.github.com>`. Do not put local machine paths, secrets, internal ticket ids, or personal emails in commits, code, or docs.

## Compatibility

Requires Paseo >= 0.14.0. The development SDK is `@getpaseo/plugin` 0.13.0.
