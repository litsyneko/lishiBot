module.exports = {
  apps: [
    {
      name: 'lavalink',
      script: 'java',
      args: '-Djava.io.tmpdir=/home/ubuntu/lishibot/lavalink/tmp -jar Lavalink.jar',
      cwd: `${__dirname}/lavalink`,
      env: {
        JAVA_TOOL_OPTIONS: '-Djava.io.tmpdir=/home/ubuntu/lishibot/lavalink/tmp',
      },
    },
    {
      name: 'lishibot',
      script: 'pnpm',
      args: 'start',
      cwd: __dirname,
      interpreter: 'none',
    },
  ],
}
