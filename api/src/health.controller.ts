import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { ok: true, service: 'darija-receptionist-api', t: new Date().toISOString() };
  }
}
