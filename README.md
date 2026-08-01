# shelter-plugins

Personal [Shelter](https://github.com/uwu/shelter) plugin collection.

## Plugins

| Plugin | Install URL |
| --- | --- |
| FakeDeafen | https://leoallday.github.io/shelter-plugins/fakedeafen/ |
| PlatformSpoofer | https://leoallday.github.io/shelter-plugins/platformspoofer/ |

## Installing

1. Open Shelter settings (Settings > Shelter).
2. Go to Plugins.
3. Click the install button and paste the install URL for the plugin you want.

Or run it from the console:

```js
shelter.plugins.addRemotePlugin(
  "fakedeafen",
  "https://leoallday.github.io/shelter-plugins/fakedeafen/"
);
```

## Building

```sh
pnpm i
pnpm lune ci
```

Builds each plugin into `dist/`. The GitHub Actions workflow deploys `dist/` to GitHub Pages on every push to `main`.
