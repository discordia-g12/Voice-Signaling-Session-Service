import buildApp from './app';
import { VoiceEventConsumer } from './modules/voice/events';
import { handleMemberEvent } from './modules/voice/moderation';

const start = async (): Promise<void> => {
  const app = buildApp();
  const port = Number(process.env.PORT) || 8080;
  const host = '0.0.0.0';

  // Eventos de Server-Roles (bans, expulsiones, salidas) para sacar al usuario de la llamada.
  // No bloquea: si RabbitMQ (nodo infra) no está, Voice arranca igual y el consumidor reintenta solo.
  const rabbitmqUrl = process.env.RABBITMQ_URL;
  if (rabbitmqUrl) {
    const consumer = new VoiceEventConsumer(handleMemberEvent(app), {
      url: rabbitmqUrl,
      exchange: process.env.RABBITMQ_EXCHANGE,
      queue: process.env.RABBITMQ_QUEUE,
      logger: app.log,
    });
    app.addHook('onClose', async () => {
      await consumer.stop();
    });
    consumer.start();
  } else {
    app.log.warn('Sin RABBITMQ_URL: un usuario baneado o expulsado no se saca de la llamada');
  }

  try {
    await app.listen({ port, host });
    app.log.info(`Server listening on ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

export { start };
