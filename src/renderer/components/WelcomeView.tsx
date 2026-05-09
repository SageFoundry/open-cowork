import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { useAppConfig } from '../store/selectors';
import type { ContentBlock } from '../types';
import { getInitialSessionTitle } from '../../shared/session-title';
import { buildProjectSummaries } from '../utils/projects';
import {
  FileText,
  BarChart3,
  FolderOpen,
  ArrowRight,
  Mail,
  X,
  Paperclip,
  BookOpen,
  FileSearch,
  ChevronDown,
  Settings,
} from 'lucide-react';

type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

import welcomeLogoSrc from '../assets/logo.png';

export function WelcomeView() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isComposingRef = useRef(false);
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; base64: string; mediaType: string }>
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { startSession, changeWorkingDir, isElectron } = useIPC();
  const workingDir = useAppStore((state) => state.workingDir);
  const sessions = useAppStore((state) => state.sessions);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const setActiveProject = useAppStore((state) => state.setActiveProject);
  const setGlobalNotice = useAppStore((state) => state.setGlobalNotice);
  const isConfigured = useAppStore((state) => state.isConfigured);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const appConfig = useAppConfig();
  const configSets = useMemo(() => {
    if (!appConfig) return [];
    return appConfig.configSets.map((cs) => ({
      ...cs,
      isActive: cs.id === appConfig.activeConfigSetId,
    }));
  }, [appConfig]);
  const canSubmit = prompt.trim().length > 0 || pastedImages.length > 0 || attachedFiles.length > 0;
  const activeProject = useMemo(() => {
    if (!activeProjectId) return null;
    return buildProjectSummaries(sessions, t('sidebar.defaultProject')).find(
      (project) => project.id === activeProjectId
    ) || null;
  }, [activeProjectId, sessions, t]);
  const effectiveWorkingDir = activeProject?.cwd || workingDir || undefined;

  const handleSelectFolder = async () => {
    try {
      const result = await changeWorkingDir(undefined, effectiveWorkingDir);
      if (result.success) {
        setActiveProject(null);
      }
      if (!result.success && result.error && result.error !== 'User cancelled') {
        setGlobalNotice({
          id: `notice-workdir-select-${Date.now()}`,
          type: 'warning',
          message: `${t('welcome.selectWorkingFolderFailed')}: ${result.error}`,
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `notice-workdir-select-${Date.now()}`,
        type: 'error',
        message:
          error instanceof Error && error.message
            ? `${t('welcome.selectWorkingFolderFailed')}: ${error.message}`
            : t('welcome.selectWorkingFolderFailed'),
      });
    }
  };

  // Handle paste event for images
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    e.preventDefault();

    const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      try {
        // Resize if needed to stay under API limit
        const resizedBlob = await resizeImageIfNeeded(blob);
        const base64 = await blobToBase64(resizedBlob);
        const url = URL.createObjectURL(resizedBlob);
        newImages.push({
          url,
          base64,
          mediaType: resizedBlob.type,
        });
      } catch (err) {
        console.error('Failed to process pasted image:', err);
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Resize and compress image if needed to stay under 5MB base64 limit
  const resizeImageIfNeeded = async (blob: Blob): Promise<Blob> => {
    // Claude API limit is 5MB for base64 encoded images
    // Base64 encoding increases size by ~33%, so we target 3.75MB for the blob
    const MAX_BLOB_SIZE = 3.75 * 1024 * 1024; // 3.75MB

    if (blob.size <= MAX_BLOB_SIZE) {
      return blob; // No need to resize
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        URL.revokeObjectURL(url);

        // Calculate scaling factor to reduce file size
        // We use a more aggressive approach: scale down until size is acceptable
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // Start with a scale factor based on size ratio
        const scale = Math.sqrt(MAX_BLOB_SIZE / blob.size);
        const quality = 0.9;

        const attemptCompress = (currentScale: number, currentQuality: number): Promise<Blob> => {
          canvas.width = Math.floor(img.width * currentScale);
          canvas.height = Math.floor(img.height * currentScale);

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          return new Promise((resolveBlob) => {
            canvas.toBlob(
              (compressedBlob) => {
                if (!compressedBlob) {
                  reject(new Error('Failed to compress image'));
                  return;
                }

                // If still too large, try again with lower quality or scale
                if (
                  compressedBlob.size > MAX_BLOB_SIZE &&
                  (currentQuality > 0.5 || currentScale > 0.3)
                ) {
                  const newQuality = Math.max(0.5, currentQuality - 0.1);
                  const newScale = currentQuality <= 0.5 ? currentScale * 0.9 : currentScale;
                  attemptCompress(newScale, newQuality).then(resolveBlob);
                } else {
                  resolveBlob(compressedBlob);
                }
              },
              blob.type || 'image/jpeg',
              currentQuality
            );
          });
        };

        attemptCompress(scale, quality).then(resolve).catch(reject);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  };

  const removeImage = (index: number) => {
    setPastedImages((prev) => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[index].url);
      updated.splice(index, 1);
      return updated;
    });
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  };

  const handleFileSelect = async () => {
    if (!isElectron || !window.electronAPI) {
      console.log('[WelcomeView] Not in Electron, file selection not available');
      return;
    }

    try {
      const filePaths = await window.electronAPI.selectFiles();
      if (filePaths.length === 0) return;

      const newFiles = filePaths.map((filePath) => {
        const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
        return {
          name: fileName,
          path: filePath,
          size: 0,
          type: 'application/octet-stream',
        };
      });

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    } catch (error) {
      console.error('[WelcomeView] Error selecting files:', error);
    }
  };

  // Handle drag and drop for images
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

    if (imageFiles.length > 0) {
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of imageFiles) {
        try {
          // Resize if needed to stay under API limit
          const resizedBlob = await resizeImageIfNeeded(file);
          const base64 = await blobToBase64(resizedBlob);
          const url = URL.createObjectURL(resizedBlob);
          newImages.push({
            url,
            base64,
            mediaType: resizedBlob.type,
          });
        } catch (err) {
          console.error('Failed to process dropped image:', err);
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

    if (otherFiles.length > 0) {
      const newFiles = await Promise.all(
        otherFiles.map(async (file) => {
          const droppedPath = 'path' in file && typeof file.path === 'string' ? file.path : '';
          const inlineDataBase64 = droppedPath ? undefined : await blobToBase64(file);

          return {
            name: file.name,
            path: droppedPath,
            size: file.size,
            type: file.type || 'application/octet-stream',
            inlineDataBase64,
          };
        })
      );

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Get value from ref to handle both controlled and uncontrolled cases
    const currentPrompt = textareaRef.current?.value || prompt;

    if (
      (!currentPrompt.trim() && pastedImages.length === 0 && attachedFiles.length === 0) ||
      isSubmitting
    )
      return;

    // Build content blocks
    const contentBlocks: ContentBlock[] = [];

    // Add images first
    pastedImages.forEach((img) => {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: img.base64,
        },
      });
    });

    // Add file attachments
    attachedFiles.forEach((file) => {
      contentBlocks.push({
        type: 'file_attachment',
        filename: file.name,
        relativePath: file.path,
        size: file.size,
        mimeType: file.type,
        inlineDataBase64: file.inlineDataBase64,
      });
    });

    // Add text if present
    if (currentPrompt.trim()) {
      contentBlocks.push({
        type: 'text',
        text: currentPrompt.trim(),
      });
    }

    // Use the global working directory (always available after app startup)
    setIsSubmitting(true);
    try {
      const sessionTitle = getInitialSessionTitle(currentPrompt, attachedFiles[0]?.name);
      const session = await startSession(sessionTitle, contentBlocks, effectiveWorkingDir);
      if (session) {
        setPrompt('');
        if (textareaRef.current) {
          textareaRef.current.value = '';
        }
        pastedImages.forEach((img) => URL.revokeObjectURL(img.url));
        setPastedImages([]);
        setAttachedFiles([]);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTagClick = (tag: string, tagPrompt: string) => {
    setSelectedTag(tag === selectedTag ? null : tag);
    if (tag !== selectedTag) {
      setPrompt(tagPrompt);
      if (textareaRef.current) {
        textareaRef.current.value = tagPrompt;
        // Trigger height adjustment
        adjustTextareaHeight();
      }
    }
  };

  // Auto-adjust textarea height based on content
  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      // Set max height to 200px (about 8 lines), then scroll
      const maxHeight = 200;
      const newHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${newHeight}px`;
      // Show scrollbar if content exceeds max height
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  };

  // Adjust height when prompt changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [prompt]);

  // Click outside model picker to close
  useEffect(() => {
    if (!modelPickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelPickerOpen]);

  const quickTags = [
    {
      id: 'create',
      label: t('welcome.createFile'),
      icon: FileText,
      prompt: t('welcome.quickPromptCreate'),
    },
    {
      id: 'crunch',
      label: t('welcome.crunchData'),
      icon: BarChart3,
      prompt: t('welcome.quickPromptCrunch'),
    },
    {
      id: 'organize',
      label: t('welcome.organizeFiles'),
      icon: FolderOpen,
      prompt: t('welcome.quickPromptOrganize'),
    },
    {
      id: 'email',
      label: t('welcome.checkEmails'),
      icon: Mail,
      prompt: t('welcome.quickPromptEmail'),
      requiresChrome: true,
    },
    {
      id: 'papers',
      label: t('welcome.searchPapers'),
      icon: BookOpen,
      prompt: t('welcome.quickPromptPapers'),
      requiresChrome: true,
    },
    {
      id: 'research-notion',
      label: t('welcome.summarizePapersToNotion'),
      icon: FileSearch,
      prompt: t('welcome.quickPromptNotion'),
      requiresNotion: true,
    },
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-5 py-10 md:px-8 md:py-14">
      <div className="max-w-[840px] w-full space-y-7 animate-fade-in">
        <div className="space-y-4 text-center">
          <div className="flex items-center justify-center gap-4">
            <img
              src={welcomeLogoSrc}
              alt={t('welcome.logoAlt')}
              className="w-16 h-16 md:w-20 md:h-20 rounded-[1.4rem] object-cover border border-border-subtle bg-background/60 shadow-soft"
            />
            <div className="text-left">
              <h1 className="text-[2.35rem] md:text-[3.1rem] leading-none font-semibold tracking-[-0.05em] text-text-primary">
                Open Cowork
              </h1>
            </div>
          </div>
          <p className="heading-serif text-[1.15rem] md:text-[1.45rem] font-medium tracking-[-0.02em] text-text-secondary text-center">
            {t('welcome.title')}
          </p>
        </div>

        {/* API Not Configured Hint */}
        {!isConfigured && (
          <p className="text-sm text-text-muted text-center">
            {t('welcome.apiNotConfigured')}{' '}
            <button
              type="button"
              onClick={() => {
                setSettingsTab('api');
                setShowSettings(true);
              }}
              className="inline-flex items-center gap-1 text-accent hover:text-accent-hover transition-colors"
            >
              {t('welcome.goToSettings')}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </p>
        )}

        {/* Quick Action Tags */}
        <div className="flex flex-wrap gap-2 justify-center px-3">
          {quickTags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => handleTagClick(tag.id, tag.prompt)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                selectedTag === tag.id
                  ? 'border-accent/30 bg-accent-muted text-accent'
                  : 'border-border-subtle bg-background/65 text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              } ${
                ('requiresChrome' in tag && tag.requiresChrome) ||
                ('requiresNotion' in tag && tag.requiresNotion)
                  ? 'relative'
                  : ''
              }`}
            >
              <tag.icon
                className={`w-4 h-4 ${selectedTag === tag.id ? 'text-accent' : 'text-text-muted'}`}
              />
              <span>{tag.label}</span>
              {'requiresChrome' in tag && tag.requiresChrome && (
                <span className="ml-1 px-1.5 py-px text-[9px] rounded bg-surface-active text-text-muted">
                  {t('welcome.chromeRequired')}
                </span>
              )}
              {'requiresNotion' in tag && tag.requiresNotion && (
                <span className="ml-1 px-1.5 py-px text-[9px] rounded bg-surface-active text-text-muted">
                  {t('welcome.notionRequired')}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Main Input Card - Right aligned */}
        <form
          onSubmit={handleSubmit}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`rounded-[1.9rem] border border-border-muted bg-background/85 shadow-soft px-5 py-5 space-y-4 transition-colors ${
            isDragging ? 'ring-2 ring-accent bg-accent/5' : ''
          }`}
        >
          {/* Image previews */}
          {pastedImages.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 pb-2 border-b border-border w-full">
              {pastedImages.map((img, index) => (
                <div key={index} className="relative group">
                  <img
                    src={img.url}
                    alt={t('welcome.pastedImageAlt', { index: index + 1 })}
                    className="w-full aspect-square object-cover rounded-lg border border-border"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-error text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* File attachments */}
          {attachedFiles.length > 0 && (
            <div className="space-y-2 mb-3">
              {attachedFiles.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary truncate">{file.name}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Text Input - Auto-resizing */}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              adjustTextareaHeight();
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onPaste={handlePaste}
            placeholder={t('welcome.placeholder')}
            rows={1}
            style={{ minHeight: '72px', maxHeight: '200px' }}
            className="w-full resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-base leading-relaxed overflow-hidden"
            onKeyDown={(e) => {
              // Enter to send, Shift+Enter for new line
              if (e.key === 'Enter' && !e.shiftKey) {
                if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
                  return;
                }
                e.preventDefault();
                handleSubmit();
              }
            }}
          />

          {/* Bottom Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-border-muted">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectFolder}
                className={`flex items-center gap-1.5 text-xs transition-colors ${
                  effectiveWorkingDir
                    ? 'text-text-secondary hover:text-text-primary'
                    : 'text-accent hover:text-accent-hover'
                }`}
                title={effectiveWorkingDir || t('welcome.selectWorkingFolder')}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>
                  {effectiveWorkingDir
                    ? effectiveWorkingDir.split(/[/\\]/).pop()
                    : t('welcome.selectWorkingFolder')}
                </span>
              </button>

              {isElectron && (
                <button
                  type="button"
                  onClick={handleFileSelect}
                  className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>{t('welcome.attachFiles')}</span>
                </button>
              )}

              {/* Model selector */}
              <div className="relative" ref={modelPickerRef}>
                <button
                  type="button"
                  onClick={() => setModelPickerOpen(!modelPickerOpen)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-border-subtle bg-background/60 text-[11px] text-text-muted hover:bg-surface-hover hover:text-text-secondary transition-colors"
                  title={appConfig?.model || t('chat.noModel')}
                >
                  <span className="max-w-[100px] truncate">
                    {appConfig?.model || t('chat.noModel')}
                  </span>
                  <ChevronDown className={`w-3 h-3 transition-transform ${modelPickerOpen ? 'rotate-180' : ''}`} />
                </button>

                {modelPickerOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-64 max-h-72 overflow-y-auto rounded-xl border border-border-subtle bg-background shadow-lg z-50 py-1.5">
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                      {t('chat.selectModel')}
                    </div>
                    {configSets.map((cs, index) => (
                      <div key={cs.id} className={index > 0 ? 'border-t border-border-subtle mt-1' : ''}>
                        {cs.isActive && (
                          <div className="px-3 pt-2 pb-0.5 text-[13px] font-semibold text-text-primary">
                            {cs.name}
                          </div>
                        )}
                        {!cs.isActive && (
                          <div className="px-3 pt-2 pb-0.5 text-[13px] text-text-muted">
                            {cs.name}
                          </div>
                        )}
                        {cs.models.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => {
                              if (option.id !== appConfig?.model || !cs.isActive) {
                                setModelPickerOpen(false);
                                if (cs.isActive) {
                                  window.electronAPI.config
                                    .save({ model: option.id })
                                    .then((result) => {
                                      if (result.success) {
                                        useAppStore.getState().setAppConfig(result.config);
                                      }
                                    })
                                    .catch((err) => console.error('[WelcomeView] Failed to switch model:', err));
                                } else {
                                  window.electronAPI.config
                                    .switchSet({ id: cs.id })
                                    .then((switchResult) => {
                                      if (!switchResult.success) return;
                                      return window.electronAPI.config.save({ model: option.id });
                                    })
                                    .then((saveResult) => {
                                      if (saveResult?.success) {
                                        useAppStore.getState().setAppConfig(saveResult.config);
                                      }
                                    })
                                    .catch((err) => console.error('[WelcomeView] Failed to switch:', err));
                                }
                              }
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                              option.id === appConfig?.model && cs.isActive
                                ? 'bg-accent/10 text-accent'
                                : 'text-text-primary hover:bg-surface-hover'
                            }`}
                          >
                            <span className="flex-1 truncate">{option.name}</span>
                            {option.id === appConfig?.model && cs.isActive && (
                              <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                    {configSets.length === 0 && (
                      <div className="px-3 py-3 text-xs text-text-muted">
                        {t('chat.noModelsAvailable')}
                      </div>
                    )}
                    <div className="border-t border-border-subtle mt-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setModelPickerOpen(false);
                          setSettingsTab('api');
                          setShowSettings(true);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] text-text-muted hover:bg-surface-hover transition-colors"
                      >
                        <Settings className="w-3 h-3" />
                        {t('chat.manageModels')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={!canSubmit || isSubmitting}
              className="btn btn-primary px-5 py-2.5 rounded-2xl disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>{isSubmitting ? t('welcome.starting') : t('welcome.letsGo')}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
