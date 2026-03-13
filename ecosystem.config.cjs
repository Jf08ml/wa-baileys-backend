module.exports = {
  apps: [
    {
      name: "wa-backend",
      script: "src/server.js",
      instances: 1, // una instancia (Baileys tiene estado en memoria)
      exec_mode: "fork", // o "cluster"=1, pero no más de 1 proceso
      node_args: "--max-old-space-size=1536", // limita heap a 1.5 GB; OOM limpio > crash silencioso
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3001,
      },
    },
  ],
};
