export interface HealthResponse {
  status: 'ok';
  time: number;
}

export interface ClientToServerEvents {
  'health:check': (acknowledge: (response: HealthResponse) => void) => void;
}

export interface ServerToClientEvents {
  'health:status': (response: HealthResponse) => void;
}
