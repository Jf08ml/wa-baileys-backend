module.exports = {
  apps: [
    {
      name: "wa-backend",
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",

      // Reinicio suave antes de llegar al OOM del kernel (2 GB RAM total en el VPS).
      // El kernel mata el proceso sin aviso si supera ~1.9 GB; esto lo reinicia antes.
      max_memory_restart: "1600M",

      // Backoff exponencial entre reinicios: 100 ms → 200 ms → … hasta 16 s.
      // Evita bucles de crash rápidos que saturan logs y CPU.
      exp_backoff_restart_delay: 100,

      // Espera mínima antes de considerar el proceso "estable" (15 s).
      // Reinicios antes de este umbral cuentan como crash para el backoff.
      min_uptime: "15s",

      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3001,
        // Bajar a 1400 deja ~600 MB para OS + Caddy + buffers, evitando el OOM.
        NODE_OPTIONS: "--max-old-space-size=1400",
      },
    },
  ],
};
