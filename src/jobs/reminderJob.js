import cron from "node-cron";
import { resetDailyCounters } from "../bulk/bulkManager.js";

const reminderJob = () => {
  // Cron para resetear contadores de campañas a medianoche
  cron.schedule(
    "0 0 * * *", // Todos los días a las 00:00
    () => {
      resetDailyCounters();
      const now = new Date();
      console.log(
        `[${now.toISOString()}] 🔄 Contadores diarios de campañas reseteados`
      );
    },
    {
      timezone: "America/Bogota",
    }
  );

  console.log("✅ Cron job de reseteo diario iniciado - Se ejecutará a medianoche (Bogotá)");
};

export default reminderJob;
