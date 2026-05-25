/**
 * 并发控制器 — 限制最大并发数，超出的请求排队等待
 *
 * 功能：
 * - 限制同时处理的最大请求数
 * - 超出的请求进入队列，按先进先出顺序处理
 * - 统计信息：当前活跃数、队列长度、总处理数
 */

class ConcurrencyLimiter {
  constructor({ maxConcurrent = 3, queueSize = 50 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.queueSize = queueSize;
    this._active = 0;
    this._queue = [];
    this._totalProcessed = 0;
    this._totalQueued = 0;
    this._totalRejected = 0;

    console.log(`🔧 并发控制器: max=${maxConcurrent}, queue=${queueSize}`);
  }

  /**
   * 提交任务（返回 Promise，排队等待执行）
   */
  submit(taskFn, context = {}) {
    return new Promise((resolve, reject) => {
      // 检查队列是否已满
      if (this._queue.length >= this.queueSize) {
        this._totalRejected++;
        reject(new Error(`队列已满 (${this.queueSize})，请稍后再试`));
        return;
      }

      // 加入队列
      const item = { taskFn, context, resolve, reject };
      this._queue.push(item);
      this._totalQueued++;

      console.log(`[Queue] 加入队列: active=${this._active}, queued=${this._queue.length}`);

      // 尝试执行
      this._processQueue();
    });
  }

  /**
   * 处理队列
   */
  _processQueue() {
    // 如果没有空闲槽位或队列为空，不处理
    if (this._active >= this.maxConcurrent || this._queue.length === 0) {
      return;
    }

    // 取出队首任务
    const item = this._queue.shift();
    this._active++;

    console.log(`[Queue] 开始执行: active=${this._active}, queued=${this._queue.length}, user=${item.context.userId || 'unknown'}`);

    // 执行任务
    item.taskFn()
      .then(result => {
        item.resolve(result);
        this._totalProcessed++;
      })
      .catch(err => {
        item.reject(err);
      })
      .finally(() => {
        this._active--;
        console.log(`[Queue] 执行完成: active=${this._active}, queued=${this._queue.length}`);
        // 继续处理队列中的下一个
        this._processQueue();
      });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      active: this._active,
      queued: this._queue.length,
      totalProcessed: this._totalProcessed,
      totalQueued: this._totalQueued,
      totalRejected: this._totalRejected,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * 清空队列
   */
  clear() {
    // 拒绝队列中的所有任务
    for (const item of this._queue) {
      item.reject(new Error('队列已清空'));
    }
    this._queue = [];
  }
}

module.exports = { ConcurrencyLimiter };
