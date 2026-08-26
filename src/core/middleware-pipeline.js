/**
 * core/middleware-pipeline.js — 回复 Middleware 管线
 *
 * 标准接口：
 *   async process(context, next) { return next(context); }
 *
 * 运行顺序完全由配置驱动（bridge.config.json 的 pipelines）。旧 Bridge 里
 * "先剥好感度 → 再提表情包 → 最后脱 Markdown" 这个顺序是硬编码在
 * streamFlush() 里的（bridge.js:862-874），而且顺序至关重要——表情 ID 含下划线，
 * 一旦先跑 stripMarkdown 就会被 Markdown 斜体规则吃掉。v2 把顺序变成显式配置，
 * 并在注册期校验依赖关系。
 */

export class MiddlewarePipeline {
  /**
   * @param {object} opts
   * @param {import('./logger.js').Logger} opts.logger
   */
  constructor(opts = {}) {
    this.log = opts.logger?.child({ component: 'middleware' }) ?? console;
    /** name -> middleware 实例 */
    this.registry = new Map();
    /** pipelineName -> string[] */
    this.pipelines = new Map();
    /**
     * 可选观察者：每个 middleware 跑完给一条 span。默认 null，不挂零开销。
     * 注意洋葱模型下 elapsedMs 是"含下游"的外层耗时，面板会自行折算自身耗时。
     * @type {((span: {pipeline:string, middleware:string, elapsedMs:number, correlationId?:string, isFinalPass?:boolean}) => void)|null}
     */
    this.observer = opts.observer ?? null;
  }

  /**
   * @param {string} name
   * @param {{ process: (ctx: object, next: Function) => Promise<object>, requiresBefore?: string[] }} middleware
   */
  register(name, middleware) {
    if (typeof middleware?.process !== 'function') {
      throw new TypeError(`middleware ${name} 缺少 process()`);
    }
    this.registry.set(name, middleware);
    return this;
  }

  /**
   * @param {string} pipelineName
   * @param {string[]} order
   */
  configure(pipelineName, order) {
    const missing = order.filter((n) => !this.registry.has(n));
    if (missing.length) {
      throw new TypeError(`管线 ${pipelineName} 引用了未注册的 middleware: ${missing.join(', ')}`);
    }

    // 顺序约束校验：requiresBefore 声明"我必须排在这些 middleware 之前"
    for (const [index, name] of order.entries()) {
      const required = this.registry.get(name).requiresBefore ?? [];
      for (const other of required) {
        const otherIndex = order.indexOf(other);
        if (otherIndex !== -1 && otherIndex < index) {
          throw new TypeError(
            `管线 ${pipelineName} 顺序非法: ${name} 必须排在 ${other} 之前（表情 ID 含下划线，` +
              `一旦先跑 ${other} 就会被破坏）`,
          );
        }
      }
    }

    this.pipelines.set(pipelineName, [...order]);
    this.log.info('管线已配置', { pipeline: pipelineName, order });
    return this;
  }

  getOrder(pipelineName) {
    return [...(this.pipelines.get(pipelineName) ?? [])];
  }

  /**
   * 执行管线。任一 middleware 抛异常都会中断管线并向上抛——回复内容的正确性
   * 不允许"部分处理"，这与广播型插件的隔离策略不同。
   *
   * @param {string} pipelineName
   * @param {object} context  { text, segments, inbound, modelResponse, config, ... }
   * @returns {Promise<object>} 处理后的 context
   */
  async run(pipelineName, context) {
    const order = this.pipelines.get(pipelineName);
    if (!order || order.length === 0) return context;

    let index = -1;
    const dispatch = async (i, ctx) => {
      if (i <= index) throw new Error(`middleware ${order[i - 1]} 重复调用了 next()`);
      index = i;
      if (i === order.length) return ctx;

      const name = order[i];
      const middleware = this.registry.get(name);
      const startedAt = Date.now();
      const result = await middleware.process(ctx, (nextCtx) => dispatch(i + 1, nextCtx ?? ctx));
      const elapsedMs = Date.now() - startedAt;
      this.log.debug('middleware 执行完成', {
        pipeline: pipelineName,
        middleware: name,
        elapsedMs,
        correlationId: ctx.correlationId,
      });
      if (this.observer) {
        try {
          this.observer({
            pipeline: pipelineName,
            middleware: name,
            elapsedMs,
            correlationId: ctx.correlationId,
            isFinalPass: ctx.isFinalPass === true,
          });
        } catch { /* 观察者不得影响回复内容 */ }
      }
      return result ?? ctx;
    };

    return dispatch(0, context);
  }
}
