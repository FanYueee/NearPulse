/**
 * ============================================================================
 * ErrorBoundary.jsx —— 讓錯誤不要變成一片白畫面
 * ============================================================================
 * 【為什麼一定要有】
 * React 元件丟出例外時，整棵樹會被卸載——畫面**完全空白**，沒有任何訊息。
 * 實際發生過：一個沒定義的函式讓整個「目前狀況」頁變成白紙，
 * 而使用者看到的只有空白，完全無從判斷是網路問題、伺服器掛了、還是程式壞了。
 *
 * 對一個緊急應用來說，白畫面是最糟的失敗方式：它連「這裡壞了，去用別的方法」
 * 都沒說。至少要留下一條出路。
 */

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 留在 console 供除錯——沒有回報端點，也不該在緊急情境下再發一次網路請求
    console.error('[NearPulse] 畫面錯誤:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="page">
        <div className="notice notice-warn" style={{ marginTop: 24 }}>
          <b>這個畫面出了問題。</b>
          <p style={{ margin: '8px 0 0' }}>
            通報功能仍然可用——不必等這裡修好。
          </p>
        </div>
        <div className="done-actions" style={{ marginTop: 16 }}>
          <a className="primary-btn btn-lg" href="#/">前往回報事件</a>
          <button className="ghost-btn" onClick={() => window.location.reload()}>
            重新載入
          </button>
        </div>
        <p className="muted-2" style={{ marginTop: 16 }}>
          {String(this.state.error?.message ?? this.state.error)}
        </p>
      </div>
    );
  }
}
