import { supabase } from './database.js';

/**
 * Uploads a file buffer directly to a Supabase Storage Bucket.
 * @param {string} bucketName - The name of the bucket (e.g., 'media-extracts')
 * @param {string} filePath - The path/filename inside the bucket
 * @param {Buffer|ArrayBuffer} fileBuffer - The binary file data
 * @param {string} contentType - The MIME type of the file
 * @returns {Promise<{url: string, error: object}>}
 */
export async function uploadFileToSupabase(bucketName, filePath, fileBuffer, contentType) {
    if (!supabase) {
        return { error: new Error("Supabase is not configured. Running in memory-only mode.") };
    }

    try {
        const { data, error } = await supabase.storage
            .from(bucketName)
            .upload(filePath, fileBuffer, {
                contentType: contentType || 'application/octet-stream',
                upsert: true
            });

        if (error) {
            console.error(`[Storage] Upload error for ${filePath}:`, error.message);
            return { error };
        }

        // Get public URL (assuming buckets are public 'media-extracts' or 'payloads')
        const { data: urlData } = supabase.storage
            .from(bucketName)
            .getPublicUrl(filePath);

        console.log(`[Storage] ✅ Uploaded ${filePath} to Supabase`);
        return { url: urlData.publicUrl, error: null };
    } catch (err) {
        console.error(`[Storage] Exception uploading ${filePath}:`, err.message);
        return { error: err };
    }
}

/**
 * Downloads a file from Supabase as a Blob/Buffer.
 * For sending to the frontend or streaming to Android.
 * @param {string} bucketName - The name of the bucket
 * @param {string} filePath - The path/filename inside the bucket
 * @returns {Promise<{data: Blob, error: object}>}
 */
export async function downloadFileFromSupabase(bucketName, filePath) {
    if (!supabase) {
        return { error: new Error("Supabase is not configured.") };
    }

    try {
        const { data, error } = await supabase.storage
            .from(bucketName)
            .download(filePath);

        if (error) {
            console.error(`[Storage] Download error for ${filePath}:`, error.message);
            return { error, data: null };
        }

        return { data, error: null };
    } catch (err) {
        console.error(`[Storage] Exception downloading ${filePath}:`, err.message);
        return { error: err, data: null };
    }
}

/**
 * Generates a signed URL for a private file, or public URL for public bucket.
 */
export function getFileUrl(bucketName, filePath) {
    if (!supabase) return null;
    
    // We assume these buckets might be set to public for ease of URL sharing with the device.
    // If private, you would use createSignedUrl instead.
    const { data } = supabase.storage
        .from(bucketName)
        .getPublicUrl(filePath);
        
    return data?.publicUrl;
}

/**
 * Deletes a file from Supabase.
 */
export async function deleteFileFromSupabase(bucketName, filePath) {
    if (!supabase) return { error: new Error("Supabase not configured") };
    
    try {
        const { error } = await supabase.storage
            .from(bucketName)
            .remove([filePath]);
            
        if (error) {
            console.error(`[Storage] Delete error for ${filePath}:`, error.message);
            return { error };
        }
        
        console.log(`[Storage] ✅ Deleted ${filePath} from Supabase`);
        return { error: null };
    } catch (err) {
        return { error: err };
    }
}
