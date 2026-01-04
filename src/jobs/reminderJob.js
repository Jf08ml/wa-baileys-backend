import cron from "node-cron";
import axios from "axios";
import { resetDailyCounters } from "../bulk/bulkManager.js";

/**
 * Sistema de Recordatorios Automático
 * - Se ejecuta cada 30 minutos
 * - Llama al endpoint de agenda-backend que procesa los recordatorios
 */
const reminderJob = () => {
  cron.schedule(
    "*/30 * * * *", // Cada 30 minutos
    async () => {
      const now = new Date();
      console.log(
        `[${now.toISOString()}] 🔔 Ejecutando verificación de recordatorios`
      );

      try {
        // Llamar al endpoint de agenda-backend
        const response = await axios.get(
          `${process.env.AGENDA_BACKEND_URL}/api/cron/daily-reminder`,
          { timeout: 120000 }
        );

        console.log(`✅ Recordatorios procesados:`, response.data);
      } catch (error) {
        console.error(`❌ Error ejecutando recordatorios:`, error.message);
      }
    },
    {
      timezone: "America/Bogota",
    }
  );

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

  console.log("✅ Cron job de recordatorios iniciado - Se ejecutará cada 30 minutos");
  console.log("✅ Cron job de reseteo diario iniciado - Se ejecutará a medianoche (Bogotá)");
};

export default reminderJob;
