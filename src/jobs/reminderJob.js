import cron from "node-cron";
import axios from "axios";

/**
 * Sistema de Recordatorios Automático
 * - Se ejecuta cada hora
 * - Llama al endpoint de agenda-backend que procesa los recordatorios
 */
const reminderJob = () => {
  cron.schedule(
    "0 * * * *", // Cada hora en punto
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

  console.log("✅ Cron job de recordatorios iniciado - Se ejecutará cada hora");
};

export default reminderJob;
