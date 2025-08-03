import RedisSubscriber from '../../src/backend/data-subscriber/redis-subscriber';

describe('RedisSubscriber', () => {
  it('should be defined', () => {
    expect(new RedisSubscriber()).toBeDefined();
  });
});
