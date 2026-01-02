import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Directory to store images
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(process.cwd(), 'data', 'images');

class ImageStorageService {
    constructor() {
        this.ensureDirectory();
    }

    /**
     * Ensure the images directory exists
     */
    private ensureDirectory(): void {
        if (!fs.existsSync(IMAGES_DIR)) {
            fs.mkdirSync(IMAGES_DIR, { recursive: true });
            console.log(`[ImageStorage] Created images directory: ${IMAGES_DIR}`);
        }
    }

    /**
     * Generate a unique filename for a post's image
     */
    private getFilename(postId: string, instagramId: string): string {
        // Use a hash to keep filenames short but unique
        const hash = crypto.createHash('md5').update(`${postId}-${instagramId}`).digest('hex').slice(0, 8);
        return `${instagramId}_${hash}.jpg`;
    }

    /**
     * Get the full path for a stored image
     */
    getImagePath(postId: string, instagramId: string): string {
        return path.join(IMAGES_DIR, this.getFilename(postId, instagramId));
    }

    /**
     * Check if an image is already stored locally
     */
    hasImage(postId: string, instagramId: string): boolean {
        const imagePath = this.getImagePath(postId, instagramId);
        return fs.existsSync(imagePath);
    }

    /**
     * Download and store an image from Instagram
     * Returns the relative path if successful, null otherwise
     */
    async downloadAndStore(
        postId: string,
        instagramId: string,
        imageUrl: string
    ): Promise<{ success: boolean; localPath?: string; error?: string }> {
        try {
            // Skip if already stored
            if (this.hasImage(postId, instagramId)) {
                const localPath = this.getFilename(postId, instagramId);
                return { success: true, localPath };
            }

            // Validate URL
            if (!imageUrl || (!imageUrl.includes('cdninstagram.com') && !imageUrl.includes('instagram.com'))) {
                return { success: false, error: 'Invalid Instagram URL' };
            }

            // Fetch the image
            const response = await fetch(imageUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.instagram.com/',
                },
            });

            if (!response.ok) {
                if (response.status === 403) {
                    return { success: false, error: 'Image expired (403)' };
                }
                return { success: false, error: `HTTP ${response.status}` };
            }

            // Get the image data
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Determine file extension from content type
            const contentType = response.headers.get('content-type') || 'image/jpeg';
            let ext = '.jpg';
            if (contentType.includes('png')) ext = '.png';
            else if (contentType.includes('webp')) ext = '.webp';
            else if (contentType.includes('gif')) ext = '.gif';

            // Generate filename (we'll always use .jpg extension for simplicity)
            const filename = this.getFilename(postId, instagramId);
            const fullPath = path.join(IMAGES_DIR, filename);

            // Write to disk
            fs.writeFileSync(fullPath, buffer);

            console.log(`[ImageStorage] Stored image for post ${instagramId}: ${filename}`);
            return { success: true, localPath: filename };

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error(`[ImageStorage] Failed to download image for ${instagramId}:`, message);
            return { success: false, error: message };
        }
    }

    /**
     * Delete a stored image
     */
    deleteImage(postId: string, instagramId: string): boolean {
        try {
            const imagePath = this.getImagePath(postId, instagramId);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`[ImageStorage] Failed to delete image:`, error);
            return false;
        }
    }

    /**
     * Get the full filesystem path for a local image filename
     */
    getFullPath(localPath: string): string {
        return path.join(IMAGES_DIR, localPath);
    }

    /**
     * Check if a local image file exists
     */
    exists(localPath: string): boolean {
        return fs.existsSync(path.join(IMAGES_DIR, localPath));
    }

    /**
     * Store image from base64 data (for client-side uploads)
     */
    storeFromBase64(
        postId: string,
        instagramId: string,
        base64Data: string
    ): { success: boolean; localPath?: string; error?: string } {
        try {
            // Skip if already stored
            if (this.hasImage(postId, instagramId)) {
                const localPath = this.getFilename(postId, instagramId);
                return { success: true, localPath };
            }

            // Remove data URL prefix if present
            const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');

            const filename = this.getFilename(postId, instagramId);
            const fullPath = path.join(IMAGES_DIR, filename);

            fs.writeFileSync(fullPath, buffer);
            console.log(`[ImageStorage] Stored uploaded image for ${instagramId}: ${filename}`);
            return { success: true, localPath: filename };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error(`[ImageStorage] Failed to store uploaded image:`, message);
            return { success: false, error: message };
        }
    }

    /**
     * Get storage stats
     */
    getStats(): { count: number; totalSizeBytes: number; directory: string } {
        try {
            const files = fs.readdirSync(IMAGES_DIR);
            let totalSize = 0;

            for (const file of files) {
                const stats = fs.statSync(path.join(IMAGES_DIR, file));
                totalSize += stats.size;
            }

            return {
                count: files.length,
                totalSizeBytes: totalSize,
                directory: IMAGES_DIR,
            };
        } catch {
            return { count: 0, totalSizeBytes: 0, directory: IMAGES_DIR };
        }
    }

    /**
     * Get all image filenames from disk
     */
    getAllImageFiles(): string[] {
        try {
            return fs.readdirSync(IMAGES_DIR).filter(f => f.endsWith('.jpg'));
        } catch {
            return [];
        }
    }
}

export const imageStorageService = new ImageStorageService();

