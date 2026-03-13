module.exports = {
  apps: [
    {
      name: "wa-backend",
      script: "src/server.js",
      instances: 1, // una instancia (Baileys tiene estado en memoria)
      exec_mode: "fork", // o "cluster"=1, pero no más de 1 proceso
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3001,
        NODE_OPTIONS: "--max-old-space-size=1536", // más confiable que node_args en PM2
      },
    },
  ],
};
