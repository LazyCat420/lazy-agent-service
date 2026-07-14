export interface Widget {
  widgetId: string;
  widgetType: 'checklist' | 'clock' | 'notes' | 'iframe_app' | 'mini_music_player' | 'youtube_player' | 'custom';
  title: string;
  htmlContent: string;
  cssContent?: string;
  jsContent?: string;
  dependencies?: string[];
  renderTarget?: string;
  renderPhase?: 'loading' | 'ready' | 'error';
}
